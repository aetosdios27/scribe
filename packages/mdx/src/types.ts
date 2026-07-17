export interface ScribeMdxOptions {
  readonly strict?: boolean;
}

export interface SerializableMdxOptions {
  readonly remarkPlugins: readonly string[];
  readonly rehypePlugins: readonly (string | readonly [string, ScribeMdxOptions])[];
}

