use crate::common::{agent_name, context, str_of};
use serde_json::Value;

const TEXT: &str = "<system-reminder>\nScheduler workflow: pick the lightest workflow that fits. Direct work: execute and verify proportionately. Otherwise: plan lanes → dispatch specialists with the Agent tool (independent lanes in parallel, run_in_background when useful) → reconcile their results → verify.\n</system-reminder>";

pub fn decide(input: &Value) -> Option<Value> {
    if str_of(input, "hook_event_name") != "SessionStart" {
        return None;
    }
    if agent_name(input).as_deref() != Some("orchestrator") {
        return None;
    }
    Some(context("SessionStart", TEXT))
}
