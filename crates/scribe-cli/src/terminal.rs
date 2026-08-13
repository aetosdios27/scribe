use std::io::{self, IsTerminal, Write};

use crossterm::style::{Color as CrosstermColor, ContentStyle, Stylize};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
};

use crate::protocol::{EngineEvent, OperationResult, PlanSummary};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tone {
    Brand,
    Dim,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug)]
pub struct Capabilities {
    pub interactive: bool,
    pub color: bool,
    pub unicode: bool,
    pub columns: u16,
}

impl Capabilities {
    pub fn detect() -> Self {
        let stdout_tty = io::stdout().is_terminal();
        let stdin_tty = io::stdin().is_terminal();
        let term = std::env::var("TERM").unwrap_or_default();
        let no_color = std::env::var_os("NO_COLOR").is_some()
            || std::env::var("FORCE_COLOR").is_ok_and(|value| value == "0");
        let columns = crossterm::terminal::size().map_or(80, |(columns, _)| columns.max(32));
        Self {
            interactive: stdin_tty && stdout_tty && !term.is_empty() && term != "dumb",
            color: stdout_tty && !no_color && term != "dumb",
            unicode: term != "dumb",
            columns,
        }
    }
}

pub struct Presenter<W: Write> {
    writer: W,
    capabilities: Capabilities,
}

impl<W: Write> Presenter<W> {
    pub const fn new(writer: W, capabilities: Capabilities) -> Self {
        Self {
            writer,
            capabilities,
        }
    }

    pub const fn capabilities(&self) -> Capabilities {
        self.capabilities
    }

    pub fn status(&mut self, title: &str, rows: &[(&str, String)]) -> io::Result<()> {
        writeln!(self.writer, "{}", self.paint(title, Tone::Brand))?;
        for (label, value) in rows {
            if self.capabilities.columns < 48 {
                writeln!(self.writer, "{}", self.paint(label, Tone::Dim))?;
                writeln!(self.writer, "  {value}")?;
            } else {
                writeln!(self.writer, "{label:<16}  {value}")?;
            }
        }
        writeln!(self.writer)
    }

    pub fn plan(&mut self, title: &str, plan: &PlanSummary) -> io::Result<()> {
        let mut rows = vec![("Project", plan.root.clone())];
        if let Some(mode) = &plan.mode {
            rows.push(("Mode", mode.clone()));
        }
        self.status(title, &rows)?;
        for package in &plan.packages {
            let current = package.current.as_deref().unwrap_or("not installed");
            let target = package.target.as_deref().unwrap_or("unchanged");
            let placement = package
                .placement
                .as_deref()
                .map_or_else(String::new, |value| format!("  ({value})"));
            writeln!(
                self.writer,
                "  {}  {current} -> {target}{placement}",
                package.name
            )?;
        }
        for command in &plan.commands {
            writeln!(self.writer, "  {}\n    {}", command.label, command.command)?;
        }
        for file in &plan.files {
            writeln!(self.writer, "  {:<10} {}", file.action, file.path)?;
        }
        for (label, value) in &plan.values {
            writeln!(self.writer, "  {label:<14} {}", display_json(value))?;
        }
        for warning in &plan.warnings {
            writeln!(self.writer, "{}  {warning}", self.symbol(Tone::Warning))?;
        }
        for step in &plan.manual_steps {
            writeln!(self.writer, "  Next  {step}")?;
        }
        writeln!(self.writer)
    }

    pub fn event(&mut self, event: &EngineEvent) -> io::Result<()> {
        match event.kind.as_str() {
            "task.started" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Brand),
                event.task.as_deref().unwrap_or("Working"),
                detail_suffix(event.detail.as_deref())
            ),
            "task.completed" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Success),
                event.task.as_deref().unwrap_or("Completed"),
                detail_suffix(event.detail.as_deref())
            ),
            "task.failed" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Error),
                event.task.as_deref().unwrap_or("Failed"),
                detail_suffix(event.detail.as_deref())
            ),
            "warning" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Warning),
                event.task.as_deref().unwrap_or("Warning"),
                detail_suffix(event.detail.as_deref())
            ),
            "process.output" => {
                if let Some(detail) = &event.detail {
                    let prefix = if event.stream.as_deref() == Some("stderr") {
                        "! "
                    } else {
                        "  "
                    };
                    writeln!(self.writer, "{prefix}{detail}")
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }

    pub fn receipt(&mut self, success: bool, result: &OperationResult) -> io::Result<()> {
        let tone = if success { Tone::Success } else { Tone::Error };
        let title = result.title.as_deref().unwrap_or(if success {
            "Scribe operation completed"
        } else {
            "Scribe operation failed"
        });
        writeln!(self.writer, "{} {title}", self.symbol(tone))?;
        if let Some(message) = &result.message {
            writeln!(self.writer, "  {message}")?;
        }
        for (label, value) in &result.values {
            writeln!(self.writer, "  {label}  {}", display_json(value))?;
        }
        writeln!(self.writer)
    }
    pub fn cancelled(&mut self, title: &str) -> io::Result<()> {
        writeln!(self.writer, "{} {title}\n", self.symbol(Tone::Dim))
    }

    pub fn failure(&mut self, title: &str, recovery: &[String]) -> io::Result<()> {
        writeln!(self.writer, "{} {title}", self.symbol(Tone::Error))?;
        for step in recovery {
            writeln!(self.writer, "  Next  {step}")?;
        }
        writeln!(self.writer)
    }

    fn symbol(&self, tone: Tone) -> String {
        let symbol = if self.capabilities.unicode {
            match tone {
                Tone::Brand => "◆",
                Tone::Success => "✓",
                Tone::Warning => "!",
                Tone::Error => "×",
                Tone::Dim => "–",
            }
        } else {
            match tone {
                Tone::Brand => "*",
                Tone::Success => "+",
                Tone::Warning => "!",
                Tone::Error => "x",
                Tone::Dim => "-",
            }
        };
        self.paint(symbol, tone)
    }

    fn paint(&self, value: &str, tone: Tone) -> String {
        if !self.capabilities.color {
            return value.to_owned();
        }
        format!("{}", terminal_style(tone).apply(value))
    }
}

pub fn prompt_text(label: &str, initial: Option<&str>) -> io::Result<Option<String>> {
    let mut stdout = io::stdout().lock();
    match initial {
        Some(value) => write!(stdout, "{label} [{value}]  ")?,
        None => write!(stdout, "{label}  ")?,
    }
    stdout.flush()?;
    let mut input = String::new();
    if io::stdin().read_line(&mut input)? == 0 {
        return Ok(None);
    }
    let value = input.trim();
    if value.is_empty() {
        Ok(initial.map(ToOwned::to_owned))
    } else {
        Ok(Some(value.to_owned()))
    }
}

pub fn prompt_confirm(label: &str, initial: bool) -> io::Result<Option<bool>> {
    let hint = if initial { "Y/n" } else { "y/N" };
    let mut stdout = io::stdout().lock();
    write!(stdout, "{label} [{hint}]  ")?;
    stdout.flush()?;
    let mut input = String::new();
    if io::stdin().read_line(&mut input)? == 0 {
        return Ok(None);
    }
    let value = input.trim();
    if value.is_empty() {
        return Ok(Some(initial));
    }
    match value.to_ascii_lowercase().as_str() {
        "y" | "yes" => Ok(Some(true)),
        "n" | "no" => Ok(Some(false)),
        _ => {
            writeln!(io::stderr(), "Expected yes or no.")?;
            prompt_confirm(label, initial)
        }
    }
}

pub fn render_inline_screen(
    title: &str,
    description: &str,
    rows: &[(&str, &str)],
) -> io::Result<()> {
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::with_options(
        backend,
        ratatui::TerminalOptions {
            viewport: ratatui::Viewport::Inline(12),
        },
    )?;
    terminal.draw(|frame| {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(2), Constraint::Min(4)])
            .split(frame.area());
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("S C R I B E", style(Tone::Brand)),
                Span::raw("  "),
                Span::styled(title, Style::default().add_modifier(Modifier::BOLD)),
            ])),
            chunks[0],
        );
        let mut text = vec![Line::from(description), Line::default()];
        text.extend(rows.iter().map(|(label, value)| {
            Line::from(vec![
                Span::styled(format!("{label:<14}"), style(Tone::Dim)),
                Span::raw(*value),
            ])
        }));
        frame.render_widget(
            Paragraph::new(Text::from(text))
                .block(
                    Block::default()
                        .borders(Borders::LEFT)
                        .border_style(style(Tone::Brand)),
                )
                .wrap(Wrap { trim: false }),
            chunks[1],
        );
    })?;
    Ok(())
}

fn style(tone: Tone) -> Style {
    match tone {
        Tone::Brand => Style::default().fg(Color::Rgb(80, 131, 230)),
        Tone::Dim => Style::default().fg(Color::DarkGray),
        Tone::Success => Style::default().fg(Color::Green),
        Tone::Warning => Style::default().fg(Color::Yellow),
        Tone::Error => Style::default().fg(Color::Red),
    }
}
fn terminal_style(tone: Tone) -> ContentStyle {
    let color = match tone {
        Tone::Brand => CrosstermColor::Rgb {
            r: 80,
            g: 131,
            b: 230,
        },
        Tone::Dim => CrosstermColor::DarkGrey,
        Tone::Success => CrosstermColor::Green,
        Tone::Warning => CrosstermColor::Yellow,
        Tone::Error => CrosstermColor::Red,
    };
    ContentStyle::new().with(color)
}

fn detail_suffix(detail: Option<&str>) -> String {
    detail.map_or_else(String::new, |detail| format!("  {detail}"))
}

fn display_json(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_renderer_never_emits_control_sequences() {
        let mut output = Vec::new();
        let capabilities = Capabilities {
            interactive: false,
            color: false,
            unicode: false,
            columns: 40,
        };
        let mut presenter = Presenter::new(&mut output, capabilities);
        presenter
            .status(
                "Scribe",
                &[("Project", "/a/very/long/project/path".to_owned())],
            )
            .expect("render status");
        let shown = String::from_utf8(output).expect("utf8");
        assert!(!shown.contains('\u{1b}'));
        assert!(shown.contains("Project\n"));
    }
}
