use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct TimelineSequence {
    pub id: String,
    pub sequence_id: String,
    pub track_type: TrackType,
    pub start_time_ms: i32, // in milliseconds
                            // pub duration_ms: i32,   // in milliseconds
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum TrackType {
    Audio,
    Video,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedTimelineStateConfig {
    pub timeline_sequences: Vec<TimelineSequence>,
}