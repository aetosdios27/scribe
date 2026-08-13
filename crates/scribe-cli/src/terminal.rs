use std::{
    io::{self, IsTerminal, Write},
    thread,
    time::{Duration, Instant},
};

use crossterm::style::{Color as CrosstermColor, ContentStyle, Stylize};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
};

use crate::{
    VERSION,
    logo::{ScribeLogo, logo_height, logo_width},
    protocol::{EngineEvent, OperationResult, PlanSummary},
};

// -----------------------------------------------------------------------------
// Splash animation
// -----------------------------------------------------------------------------

/// Total wall-clock duration of the logo entrance.
///
/// Phase is derived from elapsed time rather than frame count, so a slow
/// terminal drops frames instead of making the animation itself run slower.
const LOGO_ANIMATION_DURATION: Duration = Duration::from_millis(900);

/// Maximum redraw frequency.
///
/// ~30 FPS is visually smooth in a terminal without needlessly hammering the
/// backend with redraws that most terminal emulators cannot meaningfully show.
const LOGO_FRAME_INTERVAL: Duration = Duration::from_millis(33);

/// The shader's fully settled phase.
const LOGO_ANIMATION_END_PHASE: u16 = 1000;

/// Number of ordinary text rows beneath the logo before the status body.
const HEADER_ROWS: u16 = 3;

/// Blank row permanently reserved for the shell cursor after the inline TUI.
///
/// This is deliberately outside the bordered status block. The shell therefore
/// starts on a clean row instead of overwriting the final status lines.
const CURSOR_ROWS: u16 = 1;

// -----------------------------------------------------------------------------
// Presentation
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Bare `scribe` inline screen
// -----------------------------------------------------------------------------

type InlineTerminal = Terminal<CrosstermBackend<io::Stdout>>;

pub fn render_inline_screen(
    title: &str,
    description: &str,
    rows: &[(&str, &str)],
) -> io::Result<()> {
    let capabilities = Capabilities::detect();

    // Ratatui's inline renderer is meant for a real terminal. When stdout is
    // redirected, emit stable plain text instead of cursor-control sequences.
    if !io::stdout().is_terminal() || terminal_is_dumb() {
        let mut stdout = io::stdout().lock();

        return write_plain_inline_screen(&mut stdout, title, description, rows);
    }

    let terminal_width =
        crossterm::terminal::size().map_or(capabilities.columns, |(width, _)| width.max(1));

    let show_logo = terminal_width >= logo_width().saturating_add(4);

    let logo_rows = if show_logo {
        logo_height().saturating_add(1)
    } else {
        0
    };

    let body_rows = inline_body_height(terminal_width, description, rows);

    let height = logo_rows
        .saturating_add(HEADER_ROWS)
        .saturating_add(body_rows)
        .saturating_add(CURSOR_ROWS);

    let backend = CrosstermBackend::new(io::stdout());

    let mut terminal = Terminal::with_options(
        backend,
        ratatui::TerminalOptions {
            viewport: ratatui::Viewport::Inline(height),
        },
    )?;

    let animate = animation_enabled(show_logo, capabilities);

    if animate {
        let animation_started = Instant::now();

        loop {
            let frame_started = Instant::now();
            let elapsed = animation_started.elapsed();

            let finished = elapsed >= LOGO_ANIMATION_DURATION;

            let phase = animation_phase(elapsed);

            draw_inline_frame(
                &mut terminal,
                show_logo,
                phase,
                finished,
                capabilities.color,
                body_rows,
                title,
                description,
                rows,
            )?;

            if finished {
                break;
            }

            // Frame pacing is capped, but animation progress itself is based
            // on elapsed wall-clock time. If rendering becomes slow, frames
            // are skipped rather than extending the animation duration.
            let render_time = frame_started.elapsed();

            let remaining = LOGO_FRAME_INTERVAL.saturating_sub(render_time);

            if !remaining.is_zero() {
                thread::sleep(remaining);
            }
        }
    } else {
        draw_inline_frame(
            &mut terminal,
            show_logo,
            LOGO_ANIMATION_END_PHASE,
            true,
            capabilities.color,
            body_rows,
            title,
            description,
            rows,
        )?;
    }

    // `set_cursor_position` on the final frame already makes it visible, but
    // explicitly restoring visibility makes the post-TUI shell handoff robust
    // across terminal backends.
    terminal.show_cursor()?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn draw_inline_frame(
    terminal: &mut InlineTerminal,
    show_logo: bool,
    phase: u16,
    final_frame: bool,
    color_enabled: bool,
    body_rows: u16,
    title: &str,
    description: &str,
    rows: &[(&str, &str)],
) -> io::Result<()> {
    terminal
        .draw(|frame| {
            let constraints = if show_logo {
                vec![
                    Constraint::Length(logo_height()),
                    Constraint::Length(1),
                    Constraint::Length(HEADER_ROWS),
                    Constraint::Length(body_rows),
                    Constraint::Length(CURSOR_ROWS),
                ]
            } else {
                vec![
                    Constraint::Length(HEADER_ROWS),
                    Constraint::Length(body_rows),
                    Constraint::Length(CURSOR_ROWS),
                ]
            };

            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints(constraints)
                .split(frame.area());

            let (header, body, cursor_row) = if show_logo {
                frame.render_widget(ScribeLogo::new(phase), chunks[0]);

                (chunks[2], chunks[3], chunks[4])
            } else {
                (chunks[0], chunks[1], chunks[2])
            };

            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        format!("Publishing SDK · {VERSION}"),
                        screen_style(Tone::Dim, color_enabled),
                    )),
                    Line::default(),
                    Line::from(Span::styled(
                        title,
                        Style::default().add_modifier(Modifier::BOLD),
                    )),
                ]),
                header,
            );

            let mut text = vec![Line::from(description), Line::default()];

            text.extend(rows.iter().map(|(label, value)| {
                Line::from(vec![
                    Span::styled(
                        format!("{label:<14}"),
                        screen_style(Tone::Dim, color_enabled),
                    ),
                    Span::raw(*value),
                ])
            }));

            frame.render_widget(
                Paragraph::new(Text::from(text))
                    .block(
                        Block::default()
                            .borders(Borders::LEFT)
                            .border_style(screen_style(Tone::Brand, color_enabled)),
                    )
                    .wrap(Wrap { trim: false }),
                body,
            );

            // Ratatui hides the cursor when no position is requested.
            //
            // On the final frame we explicitly park it on a dedicated blank
            // row *below* the status block. The shell therefore resumes there
            // rather than at whichever logo cell happened to be diffed last.
            if final_frame {
                frame.set_cursor_position((cursor_row.x, cursor_row.y));
            }
        })
        .map(|_| ())
}

// -----------------------------------------------------------------------------
// Animation behavior
// -----------------------------------------------------------------------------

fn animation_enabled(show_logo: bool, capabilities: Capabilities) -> bool {
    show_logo && capabilities.color && !env_flag("CI") && !env_flag("SCRIBE_NO_ANIMATION")
}

fn animation_phase(elapsed: Duration) -> u16 {
    if elapsed >= LOGO_ANIMATION_DURATION {
        return LOGO_ANIMATION_END_PHASE;
    }

    let duration = LOGO_ANIMATION_DURATION.as_nanos();

    if duration == 0 {
        return LOGO_ANIMATION_END_PHASE;
    }

    let scaled = elapsed
        .as_nanos()
        .saturating_mul(u128::from(LOGO_ANIMATION_END_PHASE))
        / duration;

    u16::try_from(scaled)
        .unwrap_or(LOGO_ANIMATION_END_PHASE)
        .min(LOGO_ANIMATION_END_PHASE)
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        let value = value.trim().to_ascii_lowercase();

        !value.is_empty() && !matches!(value.as_str(), "0" | "false" | "no" | "off")
    })
}

// -----------------------------------------------------------------------------
// Inline sizing
// -----------------------------------------------------------------------------

fn inline_body_height(terminal_width: u16, description: &str, rows: &[(&str, &str)]) -> u16 {
    // LEFT border consumes one terminal cell.
    let content_width = terminal_width.saturating_sub(1).max(1);

    let mut height = wrapped_line_count(description, content_width).saturating_add(1); // blank line after description

    for (label, value) in rows {
        let row = format!("{label:<14}{value}");

        height = height.saturating_add(wrapped_line_count(&row, content_width));
    }

    height.max(1)
}

fn wrapped_line_count(value: &str, width: u16) -> u16 {
    let width = usize::from(width.max(1));

    value
        .split('\n')
        .fold(0u16, |total, line| {
            let characters = line.chars().count();

            let lines = if characters == 0 {
                1
            } else {
                characters.div_ceil(width)
            };

            total.saturating_add(u16::try_from(lines).unwrap_or(u16::MAX))
        })
        .max(1)
}

// -----------------------------------------------------------------------------
// Plain-output fallback
// -----------------------------------------------------------------------------

fn write_plain_inline_screen<W: Write>(
    writer: &mut W,
    title: &str,
    description: &str,
    rows: &[(&str, &str)],
) -> io::Result<()> {
    writeln!(writer, "Scribe · Publishing SDK · {VERSION}")?;

    writeln!(writer)?;

    writeln!(writer, "{title}")?;

    writeln!(writer, "{description}")?;

    if !rows.is_empty() {
        writeln!(writer)?;
    }

    for (label, value) in rows {
        writeln!(writer, "{label:<14}{value}")?;
    }

    Ok(())
}

fn terminal_is_dumb() -> bool {
    std::env::var("TERM").is_ok_and(|term| term == "dumb")
}

// -----------------------------------------------------------------------------
// Styling
// -----------------------------------------------------------------------------

fn screen_style(tone: Tone, color_enabled: bool) -> Style {
    if !color_enabled {
        return Style::default();
    }

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

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

fn detail_suffix(detail: Option<&str>) -> String {
    detail.map_or_else(String::new, |detail| format!("  {detail}"))
}

fn display_json(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), ToOwned::to_owned)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

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

    #[test]
    fn piped_splash_is_plain_text() {
        let mut output = Vec::new();

        write_plain_inline_screen(
            &mut output,
            "Project status",
            "Scribe is integrated here.",
            &[("state", "integrated"), ("next", "scribe update")],
        )
        .expect("plain splash");

        let shown = String::from_utf8(output).expect("utf8");

        assert!(!shown.contains('\u{1b}'));

        assert!(shown.contains("Scribe · Publishing SDK",));

        assert!(shown.contains("Project status",));

        assert!(shown.contains("scribe update",));
    }

    #[test]
    fn animation_phase_tracks_wall_clock_time() {
        assert_eq!(animation_phase(Duration::ZERO,), 0);

        assert_eq!(
            animation_phase(LOGO_ANIMATION_DURATION / 2,),
            LOGO_ANIMATION_END_PHASE / 2
        );

        assert_eq!(
            animation_phase(LOGO_ANIMATION_DURATION,),
            LOGO_ANIMATION_END_PHASE
        );

        assert_eq!(
            animation_phase(LOGO_ANIMATION_DURATION + Duration::from_secs(10),),
            LOGO_ANIMATION_END_PHASE
        );
    }

    #[test]
    fn body_height_has_no_phantom_trailing_rows() {
        let height = inline_body_height(
            80,
            "Everything is ready.",
            &[("state", "integrated"), ("next", "scribe update")],
        );

        // description
        // blank separator
        // state
        // next
        assert_eq!(height, 4);
    }

    #[test]
    fn wrapped_lines_expand_body_height() {
        let height = inline_body_height(
            20,
            "This description is deliberately long enough to wrap.",
            &[],
        );

        assert!(height > 2);
    }

    #[test]
    fn wrapped_line_count_handles_empty_lines() {
        assert_eq!(wrapped_line_count("", 80,), 1);

        assert_eq!(wrapped_line_count("\n", 80,), 2);
    }
}
