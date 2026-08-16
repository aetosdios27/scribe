use std::{env, io, path::PathBuf, process::ExitCode};

use clap::Parser;
use serde::Serialize;
use serde_json::json;

use crate::{
    VERSION,
    cli::{Cli, Command, StudioArgs, StudioCommand, StudioInitArgs, ValidateArgs},
    engine::{EngineClient, EngineError},
    protocol::{OperationResult, PlanEnvelope},
    terminal::{
        BoxFrame, Capabilities, Presenter, close_frame, open_frame, prompt_confirm, prompt_text,
        render_inline_screen, run_stage, stage_presenter, write_box_top,
    },
};

pub fn run() -> ExitCode {
    match run_inner() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            let capabilities = Capabilities::detect();
            let mut presenter = Presenter::new(io::stderr(), capabilities);
            let recovery = recovery(&error);
            let _ = presenter.failure(&error.to_string(), &recovery);
            ExitCode::from(exit_code(&error))
        }
    }
}

fn run_inner() -> Result<u8, EngineError> {
    install_interrupt_handler();
    let cli = Cli::parse();
    let cwd = env::current_dir().map_err(EngineError::Io)?;
    let engine_entry = engine_entry()?;
    let invoked_binary = env::args().next().unwrap_or_else(|| "scribe".to_owned());
    let mut engine = EngineClient::spawn(&engine_entry, &cwd, VERSION, &invoked_binary)?;
    let capabilities = Capabilities::detect();
    let mut presenter = Presenter::new(io::stdout(), capabilities);
    let Some(command) = cli.command else {
        return show_status(&mut engine, &mut presenter);
    };

    match command {
        Command::Validate(arguments) => {
            run_validate(&mut engine, capabilities, arguments)?;
        }
        Command::Studio(arguments) => match arguments.command {
            Some(StudioCommand::Init(init_arguments)) => {
                run_studio_init(&mut engine, capabilities, &init_arguments)?;
            }
            None => {
                run_studio_start(&mut engine, capabilities, arguments)?;
            }
        },
        Command::Init(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                capabilities,
                "init.plan",
                "init.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
        Command::Integrate(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                capabilities,
                "integrate.plan",
                "integrate.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
        Command::Import(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                capabilities,
                "medium.plan",
                "medium.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
        Command::Update(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                capabilities,
                "update.plan",
                "update.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
    }
    Ok(0)
}

fn run_validate(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    arguments: ValidateArgs,
) -> Result<(), EngineError> {
    run_stage(capabilities, "RUN", EngineError::Io, |run| {
        let result: OperationResult = engine.request("validate", arguments, |event| {
            let _ = run.event(&event);
        })?;
        run.receipt(true, &result).map_err(EngineError::Io)
    })
}

fn run_studio_start(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    arguments: StudioArgs,
) -> Result<(), EngineError> {
    let Some(article) = arguments.article else {
        return Err(EngineError::Usage(
            "scribe studio requires an article path, or run `scribe studio init`.".to_owned(),
        ));
    };
    let params = json!({
        "article": article,
        "mode": arguments.mode,
        "hostCss": arguments.host_css,
        "port": arguments.port,
        "noOpen": arguments.no_open,
    });
    run_stage(capabilities, "RUN", EngineError::Io, |run| {
        let result: OperationResult = engine.request("studio.start", params, |event| {
            let _ = run.event(&event);
        })?;
        run.receipt(true, &result).map_err(EngineError::Io)
    })
}

fn show_status(
    engine: &mut EngineClient,
    presenter: &mut Presenter<impl io::Write>,
) -> Result<u8, EngineError> {
    let result: OperationResult = engine.request("status", json!({}), |event| {
        let _ = presenter.event(&event);
    })?;
    if presenter.capabilities().interactive {
        let rows = result
            .values
            .iter()
            .map(|(label, value)| {
                (
                    label.clone(),
                    value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned),
                )
            })
            .collect::<Vec<_>>();
        let borrowed = rows
            .iter()
            .map(|(label, value)| (label.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        render_inline_screen(
            result.title.as_deref().unwrap_or("Project status"),
            result.message.as_deref().unwrap_or(""),
            &borrowed,
        )
        .map_err(EngineError::Io)?;
    } else {
        presenter.receipt(true, &result).map_err(EngineError::Io)?;
    }
    Ok(0)
}

fn run_studio_init(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    arguments: &StudioInitArgs,
) -> Result<(), EngineError> {
    let frame = open_frame(capabilities);
    let details = collect_article_details(engine, capabilities, frame, arguments);
    close_frame(frame).map_err(EngineError::Io)?;

    let Some((title, slug, path)) = details? else {
        return Ok(());
    };

    let params = json!({
        "options": {
            "title": title,
            "slug": slug,
            "path": path,
            "contentDirectory": arguments.content_dir,
            "mode": arguments.mode,
            "hostCss": arguments.host_css,
            "port": arguments.port,
            "noOpen": arguments.no_open,
        },
        "interactive": capabilities.interactive,
    });
    plan_and_apply(
        engine,
        capabilities,
        "studioArticle.plan",
        "studioArticle.apply",
        params,
        true,
        arguments.yes,
    )
}

/// Gathers the title, slug, and path for a new article, all inside `frame`.
/// Returns `None` if the user cancelled at any prompt.
///
/// This never closes `frame` itself: the caller does that exactly once,
/// after this returns, so every exit path — including any engine request
/// here failing — leaves a closed box instead of an abandoned one.
fn collect_article_details(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    frame: Option<BoxFrame>,
    arguments: &StudioInitArgs,
) -> Result<Option<(String, String, PathBuf)>, EngineError> {
    if let Some(frame) = frame {
        write_box_top(&mut io::stdout(), frame, "ARTICLE DETAILS").map_err(EngineError::Io)?;
    }

    let Some(title) = resolve_article_title(capabilities, frame, arguments.title.as_deref())?
    else {
        return Ok(None);
    };

    let defaults: OperationResult = engine.request(
        "studioArticle.suggest",
        json!({
            "title": title,
            "contentDirectory": arguments.content_dir,
            "path": arguments.path,
        }),
        |_| {},
    )?;
    let derived_slug = result_string(&defaults, "slug")?;
    let mut default_path = result_string(&defaults, "targetPath")?;

    let Some((slug, recalculate_path)) = resolve_article_slug(
        capabilities,
        frame,
        arguments.slug.as_deref(),
        &derived_slug,
        arguments.yes,
    )?
    else {
        return Ok(None);
    };

    if arguments.path.is_none() && recalculate_path {
        default_path =
            suggested_article_path(engine, &title, &slug, arguments.content_dir.as_ref())?;
    }

    let Some(path) = resolve_article_path(
        capabilities,
        frame,
        arguments.path.as_ref(),
        &default_path,
        arguments.yes,
    )?
    else {
        return Ok(None);
    };

    Ok(Some((title, slug, path)))
}

fn resolve_article_title(
    capabilities: Capabilities,
    frame: Option<BoxFrame>,
    provided: Option<&str>,
) -> Result<Option<String>, EngineError> {
    if let Some(title) = provided {
        return Ok(Some(title.to_owned()));
    }
    if !capabilities.interactive {
        return Err(EngineError::Usage(
            "Article title is required in a non-interactive terminal. Pass --title and --yes."
                .to_owned(),
        ));
    }
    let Some(title) = prompt_text("Article title", None, frame).map_err(EngineError::Io)? else {
        cancel_in_frame(frame, capabilities, "No article was created.").map_err(EngineError::Io)?;
        return Ok(None);
    };
    Ok(Some(title))
}

fn resolve_article_slug(
    capabilities: Capabilities,
    frame: Option<BoxFrame>,
    provided: Option<&str>,
    derived: &str,
    yes: bool,
) -> Result<Option<(String, bool)>, EngineError> {
    if let Some(slug) = provided {
        return Ok(Some((slug.to_owned(), slug != derived)));
    }
    if yes {
        return Ok(Some((derived.to_owned(), false)));
    }
    if !capabilities.interactive {
        return Err(EngineError::Usage(
            "Re-run with --yes to accept the derived slug and article path.".to_owned(),
        ));
    }
    let Some(slug) = prompt_text("Slug", Some(derived), frame).map_err(EngineError::Io)? else {
        cancel_in_frame(frame, capabilities, "No article was created.").map_err(EngineError::Io)?;
        return Ok(None);
    };
    let changed = slug != derived;
    Ok(Some((slug, changed)))
}

fn resolve_article_path(
    capabilities: Capabilities,
    frame: Option<BoxFrame>,
    provided: Option<&PathBuf>,
    default_path: &str,
    yes: bool,
) -> Result<Option<PathBuf>, EngineError> {
    if let Some(path) = provided {
        return Ok(Some(path.clone()));
    }
    if yes {
        return Ok(Some(PathBuf::from(default_path)));
    }
    if !capabilities.interactive {
        return Err(EngineError::Usage(
            "Re-run with --yes to accept the derived slug and article path.".to_owned(),
        ));
    }
    let Some(path) =
        prompt_text("Article path", Some(default_path), frame).map_err(EngineError::Io)?
    else {
        cancel_in_frame(frame, capabilities, "No article was created.").map_err(EngineError::Io)?;
        return Ok(None);
    };
    Ok(Some(PathBuf::from(path)))
}

/// Writes a boxed cancellation line inside `frame` without closing it — the
/// same one-close-site convention every boxed flow follows.
fn cancel_in_frame(
    frame: Option<BoxFrame>,
    capabilities: Capabilities,
    message: &str,
) -> io::Result<()> {
    stage_presenter(frame, capabilities).cancelled(message)
}
fn suggested_article_path(
    engine: &mut EngineClient,
    title: &str,
    slug: &str,
    content_directory: Option<&PathBuf>,
) -> Result<String, EngineError> {
    let revised: OperationResult = engine.request(
        "studioArticle.suggest",
        json!({
            "title": title,
            "slug": slug,
            "contentDirectory": content_directory,
        }),
        |_| {},
    )?;
    result_string(&revised, "targetPath")
}

fn result_string(result: &OperationResult, key: &str) -> Result<String, EngineError> {
    result
        .values
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            EngineError::Protocol(format!(
                "engine response omitted required string value {key}"
            ))
        })
}

fn plan_and_apply<P: Serialize>(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    plan_method: &str,
    apply_method: &str,
    params: P,
    apply: bool,
    yes: bool,
) -> Result<(), EngineError> {
    let review_frame = open_frame(capabilities);
    let review_outcome = review_plan(
        engine,
        capabilities,
        review_frame,
        plan_method,
        params,
        apply,
        yes,
    );
    close_frame(review_frame).map_err(EngineError::Io)?;

    let Some(plan_id) = review_outcome? else {
        return Ok(());
    };

    run_stage(capabilities, "RUN", EngineError::Io, |run| {
        let result: OperationResult =
            engine.request(apply_method, json!({ "planId": plan_id }), |event| {
                let _ = run.event(&event);
            })?;
        run.receipt(true, &result).map_err(EngineError::Io)
    })
}

/// Requests the plan, displays it, and — unless this is a dry run — asks
/// for confirmation, all inside `frame`. Returns the plan id to apply, or
/// `None` if nothing should be applied (dry run or declined).
///
/// This never closes `frame` itself: the caller does that exactly once,
/// after this returns, so every exit path — including the plan request
/// itself failing — leaves a closed box instead of an abandoned one.
fn review_plan<P: Serialize>(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    frame: Option<BoxFrame>,
    plan_method: &str,
    params: P,
    apply: bool,
    yes: bool,
) -> Result<Option<String>, EngineError> {
    if let Some(frame) = frame {
        write_box_top(&mut io::stdout(), frame, "REVIEW & CONFIRM").map_err(EngineError::Io)?;
    }

    let mut review = stage_presenter(frame, capabilities);

    let plan: PlanEnvelope = engine.request(plan_method, params, |event| {
        let _ = review.event(&event);
    })?;
    review
        .plan(plan_title(plan_method), &plan.summary)
        .map_err(EngineError::Io)?;

    if !apply {
        return Ok(None);
    }

    if !yes {
        if !capabilities.interactive {
            return Err(EngineError::Usage(
                "The terminal is non-interactive. Re-run with --yes after reviewing the plan."
                    .to_owned(),
            ));
        }
        if prompt_confirm("Apply this Scribe plan?", false, frame).map_err(EngineError::Io)?
            != Some(true)
        {
            review
                .cancelled("Cancelled. No changes made.")
                .map_err(EngineError::Io)?;
            return Ok(None);
        }
    }

    Ok(Some(plan.plan_id))
}

fn plan_title(method: &str) -> &'static str {
    match method {
        "init.plan" => "Scribe Init",
        "integrate.plan" => "Scribe Integration",
        "medium.plan" => "Scribe Import",
        "studioArticle.plan" => "New Scribe Article",
        "update.plan" => "Scribe Update",
        _ => "Scribe Plan",
    }
}

/// Installs Scribe's own Ctrl+C handling.
///
/// The Node engine already shuts a running Studio session down gracefully on
/// SIGINT and writes a clean final response (see `waitForTerminationSignal`
/// in `engine.ts`). Without a handler here, Rust's default SIGINT behavior
/// kills this process immediately — tearing the pipe out from under the
/// engine mid-write and crashing it with a raw `EPIPE`. Installing any
/// handler at all suppresses that default, so the first Ctrl+C simply lets
/// the engine's existing graceful shutdown finish and this process's normal
/// blocking read pick up its response. A second Ctrl+C means the user wants
/// out immediately: the engine's own SIGINT listener only lives through the
/// first signal (it removes itself once triggered), so by the second press
/// it dies on its own via Node's default disposition; this process exits
/// alongside it rather than waiting any further.
fn install_interrupt_handler() {
    let interrupted = std::sync::atomic::AtomicBool::new(false);

    let _ = ctrlc::set_handler(move || {
        if interrupted.swap(true, std::sync::atomic::Ordering::SeqCst) {
            std::process::exit(130);
        }
    });
}

fn engine_entry() -> Result<PathBuf, EngineError> {
    if let Some(entry) = env::var_os("SCRIBE_ENGINE_ENTRY") {
        return Ok(PathBuf::from(entry));
    }
    let executable = env::current_exe().map_err(EngineError::Io)?;
    let candidates = [
        executable.parent().map(|path| path.join("engine.mjs")),
        executable
            .parent()
            .and_then(|path| path.parent())
            .map(|path| path.join("dist/engine.mjs")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .ok_or_else(|| EngineError::Missing(PathBuf::from("dist/engine.mjs")))
}

fn recovery(error: &EngineError) -> Vec<String> {
    match error {
        EngineError::Missing(_) => vec!["Reinstall @scribe-sdk/cli for this platform.".to_owned()],
        EngineError::VersionMismatch { .. } => {
            vec!["Run `scribe update` to align every installed Scribe package.".to_owned()]
        }
        EngineError::ProtocolMismatch { .. } => {
            vec!["Update the complete Scribe installation together.".to_owned()]
        }
        EngineError::Remote {
            recovery,
            partial_state,
            ..
        } => {
            let mut steps = recovery.clone();
            if *partial_state {
                steps.insert(
                    0,
                    "Review the reported partial filesystem state before retrying.".to_owned(),
                );
            }
            steps
        }
        EngineError::Usage(_) => Vec::new(),
        _ => {
            vec!["Retry the command; reinstall @scribe-sdk/cli if the failure persists.".to_owned()]
        }
    }
}

fn exit_code(error: &EngineError) -> u8 {
    match error {
        EngineError::Usage(_) | EngineError::Remote { code: -32_602, .. } => 2,
        EngineError::Remote {
            kind: Some(kind), ..
        } if is_usage_kind(kind) => 2,
        _ => 1,
    }
}

fn is_usage_kind(kind: &str) -> bool {
    matches!(kind, "usage" | "path" | "unsupported")
}
