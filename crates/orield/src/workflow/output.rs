#[derive(Default)]
pub(super) struct Console {
    notice: String,
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

impl Console {
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

    #[test]
    fn events_keep_provider_text_on_one_line() {
        assert_eq!(
            detail("Starting", "#17 · plan · Fix\n日本語の表示\u{001b}"),
            "  Starting  #17 · plan · Fix 日本語の表示\n",
        );
        assert_eq!(
            detail("Stopped", "#17 · Verification\r\nfailed"),
            "  Stopped   #17 · Verification failed\n",
        );
    }
}
