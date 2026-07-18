import { createScribeRemoteMdxOptions } from "@scribe-sdk/mdx/next-remote";
import { createScribeComponents } from "@scribe-sdk/react";
import { MDXRemote } from "next-mdx-remote/rsc";

const source = `
# Peer vocabulary

The peer starts as \`choked\` until the remote side grants upload capacity.

| State | Meaning |
| --- | --- |
| \`interested\` | The peer wants pieces. |

\`\`\`rust filename="src/peer.rs" lineNumbers highlight="2"
pub enum PeerState {
    Choked,
}
\`\`\`

<Callout variant="insight" title="Allocation, not punishment">
  Choking controls upload capacity.
</Callout>
`;

export default async function Page() {
  return (
    <MDXRemote
      source={source}
      options={createScribeRemoteMdxOptions({ strict: true })}
      components={createScribeComponents()}
    />
  );
}
