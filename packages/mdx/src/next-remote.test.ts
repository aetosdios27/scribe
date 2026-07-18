import { expect, it } from "vitest";

import { createScribeRemoteMdxOptions } from "./next-remote.js";

it("returns next-mdx-remote/rsc options with executable compiler plugins", () => {
  const options = createScribeRemoteMdxOptions({ strict: true });

  expect(Object.keys(options)).toEqual(["mdxOptions"]);
  expect(options.mdxOptions.remarkPlugins).toHaveLength(1);
  expect(options.mdxOptions.rehypePlugins).toHaveLength(1);
  expect(typeof options.mdxOptions.remarkPlugins[0]).toBe("function");
  expect(options.mdxOptions.rehypePlugins[0]).toEqual([
    expect.any(Function),
    { strict: true }
  ]);
  expect(options).not.toHaveProperty("remarkPlugins");
  expect(options).not.toHaveProperty("rehypePlugins");
});
