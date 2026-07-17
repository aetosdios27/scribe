export interface ScribeMdxOptions {
  readonly strict?: boolean;
}

export interface ScribeMdxPipelineOptions {
  readonly remarkPlugins: any[];
  readonly rehypePlugins: any[];
}

export type ScribeMdxSource =
  | string
  | Uint8Array
  | {
      readonly path?: string;
      readonly value: string | Uint8Array;
    };

export interface ScribeMdxMessage {
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly message?: string | undefined;
  readonly reason: string;
  readonly ruleId?: string | null | undefined;
}

export interface ScribeCompiledMdx {
  readonly messages: readonly ScribeMdxMessage[];
  readonly value: string | Uint8Array;
}

export interface SerializableMdxOptions {
  readonly remarkPlugins: readonly string[];
  readonly rehypePlugins: readonly (string | readonly [string, ScribeMdxOptions])[];
}
