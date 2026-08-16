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
        BoxFrame, Capabilities, FormField, FormOutcome, Presenter, close_frame, open_frame,
        prompt_confirm, render_inline_screen, run_boxed_form, run_stage, stage_presenter,
        write_box_top,
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
    let Some((title, slug, path)) = collect_article_details(engine, capabilities, arguments)?
    else {
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

/// Gathers the title, slug, and path for a new article.
///
/// Slug and path can't be derived without a final title, flag-supplied or
/// typed alike, so this resolves in two phases: title first (its own
/// single-field form when it needs prompting), then slug and path together
/// as one two-field form — the pair a user is actually likely to compare
/// and adjust side by side. Returns `None` if the user cancelled either
/// phase.
fn collect_article_details(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    arguments: &StudioInitArgs,
) -> Result<Option<(String, String, PathBuf)>, EngineError> {
    let Some(title) = resolve_article_title(capabilities, arguments)? else {
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
    let default_path = result_string(&defaults, "targetPath")?;

    let Some((slug, path)) = resolve_slug_and_path(
        engine,
        capabilities,
        arguments,
        &title,
        &derived_slug,
        &default_path,
    )?
    else {
        return Ok(None);
    };

    Ok(Some((title, slug, path)))
}

/// Resolves the article title from `--title`, or a single-field form when it
/// needs prompting. `None` means the user cancelled.
fn resolve_article_title(
    capabilities: Capabilities,
    arguments: &StudioInitArgs,
) -> Result<Option<String>, EngineError> {
    if let Some(title) = &arguments.title {
        return Ok(Some(title.clone()));
    }
    if !capabilities.interactive {
        return Err(EngineError::Usage(
            "Article title is required in a non-interactive terminal. Pass --title and --yes."
                .to_owned(),
        ));
    }

    let mut fields = [FormField::new("Article title")];
    let outcome = run_boxed_form(
        "ARTICLE DETAILS",
        &mut fields,
        capabilities,
        EngineError::Io,
        |_, _| Ok(()),
    )?;
    let [title_field] = fields;

    if outcome == FormOutcome::Cancelled || title_field.buffer.is_empty() {
        cancel_notice(capabilities, "No article was created.").map_err(EngineError::Io)?;
        return Ok(None);
    }

    Ok(Some(title_field.buffer))
}

/// Resolves the slug and target path, given a final `title`: from
/// `--slug`/`--path`, from the derived defaults under `--yes`, or from a
/// two-field form. `None` means the user cancelled.
#[allow(clippy::too_many_arguments)]
fn resolve_slug_and_path(
    engine: &mut EngineClient,
    capabilities: Capabilities,
    arguments: &StudioInitArgs,
    title: &str,
    derived_slug: &str,
    default_path: &str,
) -> Result<Option<(String, PathBuf)>, EngineError> {
    if let (Some(slug), Some(path)) = (&arguments.slug, &arguments.path) {
        return Ok(Some((slug.clone(), path.clone())));
    }

    if arguments.yes {
        let slug = arguments
            .slug
            .clone()
            .unwrap_or_else(|| derived_slug.to_owned());
        let path = match &arguments.path {
            Some(path) => path.clone(),
            None if slug == derived_slug => PathBuf::from(default_path),
            None => PathBuf::from(suggested_article_path(
                engine,
                title,
                &slug,
                arguments.content_dir.as_ref(),
            )?),
        };
        return Ok(Some((slug, path)));
    }

    if !capabilities.interactive {
        return Err(EngineError::Usage(
            "Re-run with --yes to accept the derived slug and article path.".to_owned(),
        ));
    }

    let mut slug_field = FormField::new("Slug");
    if let Some(slug) = &arguments.slug {
        slug_field.buffer.clone_from(slug);
    } else {
        derived_slug.clone_into(&mut slug_field.placeholder);
    }

    let mut path_field = FormField::new("Article path");
    if let Some(path) = &arguments.path {
        path_field.buffer = path.display().to_string();
    } else {
        default_path.clone_into(&mut path_field.placeholder);
    }

    let mut fields = [slug_field, path_field];

    let outcome = run_boxed_form(
        "ARTICLE DETAILS",
        &mut fields,
        capabilities,
        EngineError::Io,
        |index, fields| -> Result<(), EngineError> {
            if index != 0 || arguments.path.is_some() {
                return Ok(());
            }
            let typed_slug = if fields[0].buffer.is_empty() {
                derived_slug.to_owned()
            } else {
                fields[0].buffer.clone()
            };
            if typed_slug != derived_slug {
                fields[1].placeholder = suggested_article_path(
                    engine,
                    title,
                    &typed_slug,
                    arguments.content_dir.as_ref(),
                )?;
            }
            Ok(())
        },
    )?;

    let [slug_field, path_field] = fields;

    if outcome == FormOutcome::Cancelled {
        cancel_notice(capabilities, "No article was created.").map_err(EngineError::Io)?;
        return Ok(None);
    }

    let slug = if slug_field.buffer.is_empty() {
        slug_field.placeholder
    } else {
        slug_field.buffer
    };
    let path = if path_field.buffer.is_empty() {
        path_field.placeholder
    } else {
        path_field.buffer
    };

    Ok(Some((slug, PathBuf::from(path))))
}

fn cancel_notice(capabilities: Capabilities, message: &str) -> io::Result<()> {
    Presenter::new(io::stdout(), capabilities).cancelled(message)
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
