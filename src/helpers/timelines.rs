use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct TimelineSequence {
    pub id: String,
    pub sequence_id: String,
    pub track_type: TrackType,
    pub track_index: u32,   // Added for multiple tracks support
    pub start_time_ms: i32, // in milliseconds
                            // pub duration_ms: i32,   // in milliseconds
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub enum TrackType {
    #[default]
    Video,
    Audio,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct SavedTimelineStateConfig {
    pub timeline_sequences: Vec<TimelineSequence>,
}