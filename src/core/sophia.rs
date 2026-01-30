use serde::{Deserialize, Serialize};
use crate::helpers::saved_data::{ResearchResult, GrammarIssue};

#[derive(Debug, Serialize, Deserialize)]
pub struct SophiaState {
    pub research_query: String,
    pub research_results: Vec<ResearchResult>,
    pub is_searching: bool,
    
    pub subjects: Vec<String>,
    pub keywords: Vec<String>,
    pub grammar_issues: Vec<GrammarIssue>,
    pub is_analyzing: bool,
    
    pub quiet_mode: bool,

    #[serde(skip)]
    pub research_rx: Option<std::sync::mpsc::Receiver<Vec<ResearchResult>>>,
    #[serde(skip)]
    pub analyze_rx: Option<std::sync::mpsc::Receiver<serde_json::Value>>,
}

impl SophiaState {
    pub fn new() -> Self {
        Self {
            research_query: String::new(),
            research_results: Vec::new(),
            is_searching: false,
            subjects: Vec::new(),
            keywords: Vec::new(),
            grammar_issues: Vec::new(),
            is_analyzing: false,
            quiet_mode: false,
            research_rx: None,
            analyze_rx: None,
        }
    }
}