//! On-disk piece store: split/verify/assemble, resume from a bitmap, promote to seed
//! (docs/P2P_PROTOCOL_DESIGN.md section 5).
//!
//! Layout under `<data_dir>/p2p/<content_id_hex>/`:
//! - `data`   — the content bytes, pre-sized to `length` and filled piece-by-piece at the
//!   correct offsets (out-of-order is fine; holes stay sparse until written). A single path
//!   the media player can open progressively.
//! - `state`  — MessagePack `{ version, piece_count, bitmap }`; the bitmap records which
//!   pieces are present *and* verified. Written atomically (temp + rename) after each piece.
//! - `sealed` — empty marker written atomically by `promote` once every piece is present.
//!
//! Every piece is SHA-256-verified against the info document *before* it is written and
//! marked present, so a hash mismatch never touches the data file or the bitmap.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::meta::{InfoDocument, HASH_LEN};

const STATE_VERSION: u32 = 1;

#[derive(Debug)]
pub enum PieceError {
    Io(std::io::Error),
    HashCountMismatch { hashes: usize, pieces: usize },
    InvalidIndex { index: u32, count: u32 },
    InvalidLength { index: u32, expected: usize, got: usize },
    HashMismatch { index: u32 },
    NotPresent { index: u32 },
    NotComplete,
    StateDecode(String),
}

impl std::fmt::Display for PieceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PieceError::Io(e) => write!(f, "piece store io error: {e}"),
            PieceError::HashCountMismatch { hashes, pieces } => {
                write!(f, "info document has {hashes} piece hashes but {pieces} pieces")
            }
            PieceError::InvalidIndex { index, count } => {
                write!(f, "piece index {index} out of range (0..{count})")
            }
            PieceError::InvalidLength { index, expected, got } => {
                write!(f, "piece {index} has {got} bytes, expected {expected}")
            }
            PieceError::HashMismatch { index } => write!(f, "piece {index} failed SHA-256 verification"),
            PieceError::NotPresent { index } => write!(f, "piece {index} not present"),
            PieceError::NotComplete => write!(f, "cannot promote: not all pieces present"),
            PieceError::StateDecode(e) => write!(f, "piece store state error: {e}"),
        }
    }
}

impl std::error::Error for PieceError {}

impl From<std::io::Error> for PieceError {
    fn from(e: std::io::Error) -> Self {
        PieceError::Io(e)
    }
}

/// A compact per-piece presence bitmap (one bit per piece, `u64` words).
struct Bitmap {
    words: Vec<u64>,
    len: u32,
}

impl Bitmap {
    fn new(len: u32) -> Self {
        let word_count = (len as usize + 63) / 64;
        Self {
            words: vec![0; word_count],
            len,
        }
    }

    fn len(&self) -> u32 {
        self.len
    }

    fn set(&mut self, i: u32) {
        self.words[(i / 64) as usize] |= 1u64 << (i % 64);
    }

    fn get(&self, i: u32) -> bool {
        (self.words[(i / 64) as usize] >> (i % 64)) & 1 == 1
    }

    fn all_set(&self) -> bool {
        if self.len == 0 {
            return true;
        }
        let full_words = (self.len / 64) as usize;
        for w in &self.words[..full_words] {
            if *w != u64::MAX {
                return false;
            }
        }
        let rem = self.len % 64;
        if rem == 0 {
            return true;
        }
        let mask = (1u64 << rem) - 1;
        (self.words[full_words] & mask) == mask
    }

    fn missing(&self) -> Vec<u32> {
        (0..self.len).filter(|&i| !self.get(i)).collect()
    }

    fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.words.len() * 8);
        for w in &self.words {
            out.extend_from_slice(&w.to_le_bytes());
        }
        out
    }

    fn from_bytes(bytes: &[u8], len: u32) -> Result<Self, PieceError> {
        let word_count = (len as usize + 63) / 64;
        if bytes.len() != word_count * 8 {
            return Err(PieceError::StateDecode(format!(
                "bitmap is {} bytes, expected {}",
                bytes.len(),
                word_count * 8
            )));
        }
        let mut words = Vec::with_capacity(word_count);
        for c in bytes.chunks_exact(8) {
            let mut a = [0u8; 8];
            a.copy_from_slice(c);
            words.push(u64::from_le_bytes(a));
        }
        Ok(Self { words, len })
    }
}

#[derive(Serialize, Deserialize)]
struct StateFile {
    version: u32,
    piece_count: u32,
    bitmap: Vec<u8>,
}

pub struct PieceStore {
    dir: PathBuf,
    data_path: PathBuf,
    state_path: PathBuf,
    sealed_path: PathBuf,
    length: u64,
    piece_length: u32,
    hashes: Vec<[u8; HASH_LEN]>,
    bitmap: Bitmap,
    data: File,
}

impl PieceStore {
    /// Opens (creating if needed) the per-content store for `info` under `data_dir`. On
    /// reopen, the previous bitmap is loaded, so a partial download resumes exactly.
    pub fn open(data_dir: &Path, info: &InfoDocument) -> Result<Self, PieceError> {
        info.validate()
            .map_err(|e| PieceError::StateDecode(e.to_string()))?;
        let hashes = info
            .decode_pieces()
            .map_err(|e| PieceError::StateDecode(e.to_string()))?;
        let count = info.piece_count();
        if hashes.len() != count as usize {
            return Err(PieceError::HashCountMismatch {
                hashes: hashes.len(),
                pieces: count as usize,
            });
        }

        let dir = data_dir.join("p2p").join(info.content_id_hex());
        fs::create_dir_all(&dir)?;
        let data_path = dir.join("data");
        let state_path = dir.join("state");
        let sealed_path = dir.join("sealed");

        let mut data = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&data_path)?;
        data.set_len(info.length)?;

        let bitmap = load_bitmap(&state_path, count)?;

        Ok(Self {
            dir,
            data_path,
            state_path,
            sealed_path,
            length: info.length,
            piece_length: info.piece_length,
            hashes,
            bitmap,
            data,
        })
    }

    /// Number of pieces this content splits into.
    pub fn piece_count(&self) -> u32 {
        self.bitmap.len()
    }

    /// Whether the piece at `index` is present and verified.
    pub fn has_piece(&self, index: u32) -> bool {
        self.bitmap.get(index)
    }

    /// Indices of pieces not yet present, in ascending order.
    pub fn missing(&self) -> Vec<u32> {
        self.bitmap.missing()
    }

    /// True once every piece is present and verified.
    pub fn is_complete(&self) -> bool {
        self.bitmap.all_set()
    }

    /// The single data-file path the media player can open.
    pub fn data_path(&self) -> &Path {
        &self.data_path
    }

    /// Whether this store has been promoted to seed.
    pub fn is_sealed(&self) -> bool {
        self.sealed_path.exists()
    }

    /// Verifies `data` against the info document's hash for `index`, then writes it at the
    /// correct offset and marks the piece present. A mismatch leaves disk and bitmap
    /// untouched. Idempotent: re-writing a present piece with correct bytes is a no-op.
    pub fn write_piece(&mut self, index: u32, data: &[u8]) -> Result<(), PieceError> {
        let count = self.bitmap.len();
        if index >= count {
            return Err(PieceError::InvalidIndex { index, count });
        }
        let expected = self.expected_len(index);
        if data.len() != expected {
            return Err(PieceError::InvalidLength {
                index,
                expected,
                got: data.len(),
            });
        }

        let digest = Sha256::digest(data);
        if digest.as_slice() != &self.hashes[index as usize] {
            return Err(PieceError::HashMismatch { index });
        }

        let offset = (index as u64) * (self.piece_length as u64);
        self.data.seek(SeekFrom::Start(offset))?;
        self.data.write_all(data)?;
        self.bitmap.set(index);
        self.save_bitmap()?;
        Ok(())
    }

    /// Reads a present, verified piece back out. Errors on a missing piece.
    pub fn read_piece(&mut self, index: u32) -> Result<Vec<u8>, PieceError> {
        let count = self.bitmap.len();
        if index >= count {
            return Err(PieceError::InvalidIndex { index, count });
        }
        if !self.bitmap.get(index) {
            return Err(PieceError::NotPresent { index });
        }
        let len = self.expected_len(index);
        let offset = (index as u64) * (self.piece_length as u64);
        self.data.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; len];
        self.data.read_exact(&mut buf)?;
        Ok(buf)
    }

    /// Re-hashes every piece on disk against the info document. The "assemble" check:
    /// confirms the whole file is present and byte-correct.
    pub fn verify_all(&mut self) -> Result<(), PieceError> {
        for i in 0..self.bitmap.len() {
            let piece = self.read_piece(i)?;
            let digest = Sha256::digest(&piece);
            if digest.as_slice() != &self.hashes[i as usize] {
                return Err(PieceError::HashMismatch { index: i });
            }
        }
        Ok(())
    }

    /// Atomically marks this content as a seed. Requires every piece to be present;
    /// idempotent if already sealed.
    pub fn promote(&self) -> Result<(), PieceError> {
        if self.is_sealed() {
            return Ok(());
        }
        if !self.bitmap.all_set() {
            return Err(PieceError::NotComplete);
        }
        let tmp = self.dir.join("sealed.tmp");
        fs::write(&tmp, b"")?;
        fs::rename(&tmp, &self.sealed_path)?;
        Ok(())
    }

    fn expected_len(&self, index: u32) -> usize {
        let start = (index as u64) * (self.piece_length as u64);
        let end = (start + self.piece_length as u64).min(self.length);
        (end - start) as usize
    }

    fn save_bitmap(&self) -> Result<(), PieceError> {
        let state = StateFile {
            version: STATE_VERSION,
            piece_count: self.bitmap.len(),
            bitmap: self.bitmap.to_bytes(),
        };
        let bytes = rmp_serde::to_vec(&state).map_err(|e| PieceError::StateDecode(e.to_string()))?;
        let tmp = self.dir.join("state.tmp");
        fs::write(&tmp, &bytes)?;
        fs::rename(&tmp, &self.state_path)?;
        Ok(())
    }
}

fn load_bitmap(state_path: &Path, count: u32) -> Result<Bitmap, PieceError> {
    match fs::read(state_path) {
        Ok(bytes) => {
            let state: StateFile =
                rmp_serde::from_slice(&bytes).map_err(|e| PieceError::StateDecode(e.to_string()))?;
            if state.version != STATE_VERSION {
                return Err(PieceError::StateDecode(format!(
                    "state version {} != {}",
                    state.version, STATE_VERSION
                )));
            }
            if state.piece_count != count {
                return Err(PieceError::StateDecode(format!(
                    "state piece_count {} != expected {}",
                    state.piece_count, count
                )));
            }
            Bitmap::from_bytes(&state.bitmap, count)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Bitmap::new(count)),
        Err(e) => Err(PieceError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos();
            let p = std::env::temp_dir().join(format!(
                "entropy-p2p-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_info(data: &[u8]) -> InfoDocument {
        InfoDocument::for_bytes("sample.bin", None, data, 16, 1_700_000_000)
    }

    #[test]
    fn split_write_verify_assemble_promote() {
        let tmp = TempDir::new("pieces-full");
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let info = sample_info(&data); // 16-byte pieces -> 63 pieces (last is 8 bytes)
        let mut store = PieceStore::open(tmp.path(), &info).unwrap();
        assert_eq!(store.piece_count(), 63);
        assert!(!store.is_complete());

        // Write out of order (reverse) to prove order-independence.
        for i in (0..store.piece_count()).rev() {
            let start = (i as usize) * 16;
            let end = (start + 16).min(data.len());
            store.write_piece(i, &data[start..end]).unwrap();
        }
        assert!(store.is_complete());
        store.verify_all().unwrap();
        store.promote().unwrap();
        assert!(store.is_sealed());

        let mut assembled = Vec::new();
        for i in 0..store.piece_count() {
            assembled.extend_from_slice(&store.read_piece(i).unwrap());
        }
        assert_eq!(assembled, data);
    }

    #[test]
    fn corrupt_piece_rejected() {
        let tmp = TempDir::new("pieces-corrupt");
        let data: Vec<u8> = vec![0xAB; 64];
        let info = sample_info(&data); // 4 pieces
        let mut store = PieceStore::open(tmp.path(), &info).unwrap();
        store.write_piece(0, &data[0..16]).unwrap();

        let mut bad = data[16..32].to_vec();
        bad[0] ^= 0xFF;
        assert!(matches!(
            store.write_piece(1, &bad),
            Err(PieceError::HashMismatch { index: 1 })
        ));
        assert!(store.has_piece(0));
        assert!(!store.has_piece(1));
        assert!(matches!(
            store.read_piece(1),
            Err(PieceError::NotPresent { index: 1 })
        ));
        assert!(!store.is_complete());
    }

    #[test]
    fn resume_exact() {
        let tmp = TempDir::new("pieces-resume");
        let data: Vec<u8> = (0..80u8).collect();
        let info = sample_info(&data); // 5 pieces
        {
            let mut store = PieceStore::open(tmp.path(), &info).unwrap();
            store.write_piece(0, &data[0..16]).unwrap();
            store.write_piece(2, &data[32..48]).unwrap();
            store.write_piece(4, &data[64..80]).unwrap();
        }

        let mut store = PieceStore::open(tmp.path(), &info).unwrap();
        assert_eq!(store.missing(), vec![1, 3]);
        assert!(store.has_piece(0) && store.has_piece(2) && store.has_piece(4));
        assert!(!store.is_complete());
        assert_eq!(store.read_piece(2).unwrap(), &data[32..48]);
        assert!(matches!(
            store.read_piece(1),
            Err(PieceError::NotPresent { index: 1 })
        ));
    }

    #[test]
    fn idempotent_write_and_reopen() {
        let tmp = TempDir::new("pieces-idempotent");
        let data: Vec<u8> = vec![0x5A; 32];
        let info = sample_info(&data); // 2 pieces
        let mut store = PieceStore::open(tmp.path(), &info).unwrap();
        store.write_piece(0, &data[0..16]).unwrap();
        store.write_piece(0, &data[0..16]).unwrap(); // same piece, same bytes -> ok
        assert!(store.has_piece(0));
        assert!(!store.is_complete());

        drop(store);
        let store2 = PieceStore::open(tmp.path(), &info).unwrap();
        assert_eq!(store2.missing(), vec![1]);
    }
}
