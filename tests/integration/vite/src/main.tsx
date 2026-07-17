import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createScribeComponents } from "@scribe/react";
import "@scribe/styles/default.css";

import Article from "../../content/article.mdx";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing Vite fixture root element.");

createRoot(root).render(
  <StrictMode>
    <Article components={createScribeComponents()} />
  </StrictMode>
);
