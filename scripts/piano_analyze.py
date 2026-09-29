"""Analyze DSP probe renders; run from entropy-engine. No per-note normalization."""
import sys, json, wave
from pathlib import Path
sys.path.insert(0, str(Path("test-artifacts/audio-python").resolve()))
import numpy as np
from scipy.signal import find_peaks
root=Path("test-artifacts/piano-probe")
rows=[]
for p in sorted(root.glob("*.f32")):
    stereo=np.fromfile(p,dtype="<f4").reshape(-1,2)
    x=stereo.mean(axis=1)
    spec=np.abs(np.fft.rfft(x[:44100]*np.hanning(44100),262144)); f=np.fft.rfftfreq(262144,1/44100)
    rms=lambda a,b: float(20*np.log10(max(1e-12,np.mean(x[int(a*44100):int(b*44100)]**2)**.5)))
    key=int(p.stem.split("-")[0]); st=key-48
    stretch=28*(st/48)**3 if st<0 else 32*(st/39)**3
    target=440*2**((st+stretch/100)/12)
    band=np.flatnonzero((f>target*.85)&(f<target*1.15)); k=band[np.argmax(spec[band])]
    a,b,c=np.log(np.maximum(spec[k-1:k+2],1e-20)); off=.5*(a-c)/(a-2*b+c)
    hz=(k+off)*44100/262144
    row=dict(name=p.stem,peakDb=float(20*np.log10(np.max(np.abs(stereo)))),centroidHz=float(np.sum(f*spec)/sum(spec)),pitchHz=float(hz),cents=float(1200*np.log2(hz/target)),promptDbPerSec=(rms(.01,.04)-rms(.15,.18))/.17,afterDbPerSec=(rms(.8,.85)-rms(2.15,2.2))/1.4,levelAtOneSecond=rms(1,1.1),dc=float(np.mean(x)))
    rows.append(row)
    with wave.open(str(p.with_suffix(".wav")),"wb") as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(44100);w.writeframes((np.clip(stereo,-1,1)*32767).astype("<i2").tobytes())
    print(row)
(root/"metrics.json").write_text(json.dumps(rows,indent=2))
