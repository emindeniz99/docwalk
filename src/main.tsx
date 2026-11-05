import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("docwalk: #root element missing from index.html");

// The presenter window (decision 8) is the same build opened with ?view=presenter.
const isPresenter = new URLSearchParams(location.search).get("view") === "presenter";

// Loaded only in the presenter window, so the audience page does not ship it.
const PresenterView = lazy(() =>
  import("./presenter/PresenterView").then((m) => ({ default: m.PresenterView })),
);

createRoot(root).render(
  <StrictMode>
    {isPresenter ? (
      <Suspense fallback={null}>
        <PresenterView />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
