use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "scribe",
    bin_name = "scribe",
    version,
    about = "Publication structure and behavior for a host-owned React site.",
    disable_help_subcommand = true,
    propagate_version = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create an empty, source-owned content launchpad.
    Init(InitArgs),
    /// Integrate Scribe deliberately into an existing React project.
    Integrate(IntegrateArgs),
    /// Import stories from an official Medium export ZIP.
    Import(ImportArgs),
    /// Compile and validate one Markdown or MDX article.
    Validate(ValidateArgs),
    /// Open Scribe's local source-authoritative authoring Studio.
    Studio(StudioArgs),
    /// Align every installed Scribe package to the current beta.
    Update(UpdateArgs),
}

#[derive(Debug, Args, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitArgs {
    /// Use one repository-relative content directory.
    #[arg(long)]
    pub content_dir: Option<PathBuf>,
    /// Also create content/assets.
    #[arg(long)]
    pub with_assets: bool,
    /// Print the plan without writing anything.
    #[arg(long)]
    pub dry_run: bool,
    /// Apply the reviewed plan without prompting.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

#[derive(Debug, Args, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrateArgs {
    /// Inspect the plan without installing or writing files.
    #[arg(long)]
    pub dry_run: bool,
    /// Select the stylesheet integration mode.
    #[arg(long, value_enum)]
    pub mode: Option<StyleMode>,
    /// Apply the reviewed plan without prompting.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

#[derive(Clone, Copy, Debug, serde::Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum StyleMode {
    Foundation,
    Default,
    Tailwind,
}

#[derive(Debug, Args, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct ImportArgs {
    /// Official Medium export ZIP.
    pub archive: PathBuf,
    /// Choose a repository-relative article directory.
    #[arg(long)]
    pub into: Option<PathBuf>,
    /// Import unpublished Medium drafts.
    #[arg(long)]
    pub include_drafts: bool,
    /// Import response-shaped entries Medium does not label.
    #[arg(long)]
    pub include_responses: bool,
    /// Keep remote Medium image URLs.
    #[arg(long)]
    pub no_download_assets: bool,
    /// Inspect the import without network or file changes.
    #[arg(long)]
    pub dry_run: bool,
    /// Accept safe defaults and apply without prompting.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

#[derive(Debug, Args, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateArgs {
    /// Markdown or MDX source file.
    pub article: PathBuf,
    /// Treat warnings as errors.
    #[arg(long)]
    pub strict: bool,
}

#[derive(Debug, Args)]
#[command(
    args_conflicts_with_subcommands = true,
    subcommand_precedence_over_arg = true
)]
pub struct StudioArgs {
    #[command(subcommand)]
    pub command: Option<StudioCommand>,
    /// Markdown or MDX source file.
    #[arg(value_name = "ARTICLE")]
    pub article: Option<PathBuf>,
    /// Override detected stylesheet integration mode.
    #[arg(long, value_enum)]
    pub mode: Option<StyleMode>,
    /// Load one explicit local host stylesheet.
    #[arg(long)]
    pub host_css: Option<PathBuf>,
    /// Require one specific loopback port.
    #[arg(long)]
    pub port: Option<u16>,
    /// Do not open the system browser automatically.
    #[arg(long)]
    pub no_open: bool,
}

#[derive(Debug, Subcommand)]
pub enum StudioCommand {
    /// Create a minimal article and open it in Studio.
    Init(StudioInitArgs),
}

#[derive(Debug, Args, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioInitArgs {
    /// Set the article title without prompting.
    #[arg(long)]
    pub title: Option<String>,
    /// Override the title-derived slug.
    #[arg(long)]
    pub slug: Option<String>,
    /// Set the final repository-relative .md or .mdx path.
    #[arg(long)]
    pub path: Option<PathBuf>,
    /// Use one repository-relative content directory.
    #[arg(long)]
    pub content_dir: Option<PathBuf>,
    /// Create the reviewed article without prompting.
    #[arg(long, short = 'y')]
    pub yes: bool,
    /// Override detected stylesheet integration mode after creation.
    #[arg(long, value_enum)]
    pub mode: Option<StyleMode>,
    /// Load one explicit local host stylesheet after creation.
    #[arg(long)]
    pub host_css: Option<PathBuf>,
    /// Require one specific loopback port after creation.
    #[arg(long)]
    pub port: Option<u16>,
    /// Do not open the system browser automatically.
    #[arg(long)]
    pub no_open: bool,
}

#[derive(Debug, Args, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    /// Show the target and exact package-manager commands without changing files.
    #[arg(long)]
    pub dry_run: bool,
    /// Apply the reviewed update without prompting.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

#[cfg(test)]
mod tests {
    use super::{Cli, Command, StudioCommand};
    use clap::Parser;

    #[test]
    fn parses_studio_init_as_a_subcommand() {
        let cli = Cli::try_parse_from(["scribe", "studio", "init", "--title", "Hello"]).unwrap();

        let Some(Command::Studio(studio)) = cli.command else {
            panic!("expected studio command");
        };
        assert!(matches!(studio.command, Some(StudioCommand::Init(_))));
        assert!(studio.article.is_none());
    }

    #[test]
    fn parses_an_article_as_the_studio_positional() {
        let cli = Cli::try_parse_from(["scribe", "studio", "content/article.mdx"]).unwrap();

        let Some(Command::Studio(studio)) = cli.command else {
            panic!("expected studio command");
        };
        assert_eq!(
            studio.article.as_deref(),
            Some(std::path::Path::new("content/article.mdx"))
        );
        assert!(studio.command.is_none());
    }
}
