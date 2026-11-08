//! portable-pty creates ConPTY with PSEUDOCONSOLE_INHERIT_CURSOR. A new
//! terminal starts at row 1, column 1; answer its initial position query before
//! exposing the session to callers. Subsequent queries belong to xterm.js.

const CURSOR_QUERY: &[u8] = b"\x1b[6n";
pub const INITIAL_CURSOR: &[u8] = b"\x1b[1;1R";

#[derive(Default)]
pub struct StartupHandshake {
    pending: Vec<u8>,
    complete: bool,
}

impl StartupHandshake {
    /// Return bytes for the emulator and whether the initial query was consumed.
    /// Retain only an incomplete query suffix between reads (at most 3 bytes).
    pub fn feed(&mut self, bytes: &[u8]) -> (Vec<u8>, bool) {
        if self.complete {
            return (bytes.to_vec(), false);
        }
        self.pending.extend_from_slice(bytes);
        if let Some(position) = self
            .pending
            .windows(CURSOR_QUERY.len())
            .position(|window| window == CURSOR_QUERY)
        {
            self.complete = true;
            let mut output = std::mem::take(&mut self.pending);
            output.drain(position..position + CURSOR_QUERY.len());
            return (output, true);
        }
        let keep = (1..CURSOR_QUERY.len())
            .rev()
            .find(|&length| self.pending.ends_with(&CURSOR_QUERY[..length]))
            .unwrap_or(0);
        let output = self.pending.drain(..self.pending.len() - keep).collect();
        (output, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_query_is_consumed_across_every_read_boundary() {
        let input = b"before\x1b[6nafter";
        for boundary in 0..=input.len() {
            let mut handshake = StartupHandshake::default();
            let (mut first, ready_first) = handshake.feed(&input[..boundary]);
            let (second, ready_second) = handshake.feed(&input[boundary..]);
            first.extend(second);
            assert_eq!(first, b"beforeafter");
            assert_ne!(ready_first, ready_second, "reply exactly once");
        }
    }

    #[test]
    fn later_cursor_queries_are_forwarded_to_the_emulator() {
        let mut handshake = StartupHandshake::default();
        assert_eq!(handshake.feed(CURSOR_QUERY), (vec![], true));
        assert_eq!(
            handshake.feed(b"prompt\x1b[6n"),
            (b"prompt\x1b[6n".to_vec(), false)
        );
    }
}
