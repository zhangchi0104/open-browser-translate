import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { Layout } from "./Layout";
// The policy lives in docs/ so the repository and the site show the same text.
import policy from "../../../docs/privacy-policy.md?raw";
import "./style.css";

function PrivacyPolicy() {
  return (
    <Layout>
      <article className="policy mx-auto max-w-[720px] px-4 pt-12 pb-20 sm:px-8 sm:pt-16">
        <Markdown>{policy}</Markdown>
      </article>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><PrivacyPolicy /></StrictMode>);
