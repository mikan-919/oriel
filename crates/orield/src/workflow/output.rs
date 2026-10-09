use std::collections::BTreeMap;

use super::{Row, Snapshot};

// Keep scrollback useful: polling prints changes, never repeats the whole scan.
#[derive(Default)]
pub(super) struct Console {
    target: String,
    rows: BTreeMap<u64, String>,
    notice: String,
    empty: bool,
}

// Provider text and errors must not inject terminal controls or extra rows.
fn line(text: &str) -> String {
    text.split_whitespace()
        .map(|word| word.chars().filter(|c| !c.is_control()).collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

fn detail(label: &str, message: &str) -> String {
    let label = line(label);
    format!("  {label:<9} {}\n", line(message))
}

pub(super) fn event(label: &str, message: impl AsRef<str>) {
    print!("{}", detail(label, message.as_ref()));
}

fn row_text(row: &Row) -> String {
    let status = match row.phase.as_str() {
        "waiting-how" => "Waiting for HOW",
        "needs-how" => "Ready to plan",
        "triage" => "Awaiting approval in Linear Todo",
        "approved" => "Ready to implement",
        "running" => "Implementing",
        "review" => "Awaiting PR review / merge",
        "merged" => "Merged; updating Linear",
        "done" => "Done",
        "closed" => "Closed",
        "blocked" => "Blocked",
        other => other,
    };
    let mut text = format!("\n#{}  {}\n", row.issue.number, line(&row.issue.title));
    text.push_str(&detail("Status", status));
    text.push_str(&detail("Issue", &row.issue.url));
    if let Some(how) = &row.linear {
        text.push_str(&detail(&how.identifier, &how.url));
    }
    if let Some(pull) = &row.pull_request {
        text.push_str(&detail("PR", &pull.url));
    }
    if let Some(reason) = &row.blocked_reason {
        text.push_str(&detail("Blocked", reason));
    }
    text
}

impl Console {
    pub(super) fn snapshot(&mut self, snapshot: &Snapshot) -> String {
        let mode = if snapshot.configuration.autonomous && snapshot.configuration.error.is_none() {
            "code enabled after approval"
        } else {
            "HOW planning only"
        };
        let mut target = detail(
            "Target",
            &format!(
                "{}/{} · {} @ {} · {mode}",
                snapshot.repository.owner,
                snapshot.repository.name,
                snapshot.base_branch,
                snapshot.target_oid.chars().take(12).collect::<String>(),
            ),
        );
        if let Some(error) = &snapshot.configuration.error {
            target.push_str(&detail("Code off", error));
        }
        let mut text = String::new();
        if self.target != target {
            text.push_str(&target);
            self.target = target;
        }
        for row in &snapshot.workflows {
            let current = row_text(row);
            if self.rows.get(&row.issue.number) != Some(&current) {
                text.push_str(&current);
                self.rows.insert(row.issue.number, current);
            }
        }
        self.rows.retain(|number, _| {
            let present = snapshot
                .workflows
                .iter()
                .any(|row| row.issue.number == *number);
            if !present {
                text.push_str(&detail(
                    "Removed",
                    &format!("#{number} is no longer tracked"),
                ));
            }
            present
        });
        if snapshot.workflows.is_empty() && !self.empty {
            text.push_str(&detail("Waiting", "No workflow issues found"));
        }
        self.empty = snapshot.workflows.is_empty();
        text
    }

    pub(super) fn warning(&mut self, message: impl AsRef<str>) {
        let message = line(message.as_ref());
        if self.notice != message {
            event("Warning", &message);
            self.notice = message;
        }
    }

    pub(super) fn connected(&mut self) {
        if !self.notice.is_empty() {
            event("Connected", "Relay connection restored");
            self.notice.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn polling_prints_only_changes_and_keeps_readable_issue_details() {
        let mut snapshot: Snapshot = serde_json::from_value(json!({
            "repository":{"owner":"octocat","name":"hello"},
            "repository_id":1,"repository_node_id":"repo","base_branch":"main",
            "target_oid":"1111111111111111111111111111111111111111",
            "configuration":{"autonomous":false,"verification":[],"error":null},
            "workflows":[{
                "issue":{"number":17,"title":"Fix\n日本語の表示","body":null,"url":"https://github.com/octocat/hello/issues/17"},
                "linear":{"identifier":"ORI-17","title":"HOW","description":null,"url":"https://linear.app/issue/ORI-17"},
                "what_comments":[],"how_comments":[],"version":"v1","phase":"triage"
            }]
        })).unwrap();
        let mut console = Console::default();
        assert_eq!(
            console.snapshot(&snapshot),
            concat!(
                "  Target    octocat/hello · main @ 111111111111 · HOW planning only\n",
                "\n#17  Fix 日本語の表示\n",
                "  Status    Awaiting approval in Linear Todo\n",
                "  Issue     https://github.com/octocat/hello/issues/17\n",
                "  ORI-17    https://linear.app/issue/ORI-17\n",
            )
        );
        assert!(console.snapshot(&snapshot).is_empty());
        snapshot.workflows[0].phase = "blocked".into();
        snapshot.workflows[0].blocked_reason = Some("Verification\nfailed\u{001b}".into());
        let changed = console.snapshot(&snapshot);
        assert!(!changed.contains("Target"));
        assert!(changed.contains("  Blocked   Verification failed\n"));
        assert!(console.snapshot(&snapshot).is_empty());
        snapshot.configuration.error = Some("Missing verification commands".into());
        let changed = console.snapshot(&snapshot);
        assert!(changed.contains("  Code off  Missing verification commands\n"));
        assert!(!changed.contains("#17"));
        assert!(console.snapshot(&snapshot).is_empty());
        snapshot.workflows.clear();
        assert_eq!(
            console.snapshot(&snapshot),
            concat!(
                "  Removed   #17 is no longer tracked\n",
                "  Waiting   No workflow issues found\n",
            )
        );
        assert!(console.snapshot(&snapshot).is_empty());
    }
}
