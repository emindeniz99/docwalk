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

// The presenter window and the phone remote (decision 8) are the same build
// opened with ?view=presenter or ?view=remote#room=..&k=..
const view = new URLSearchParams(location.search).get("view");

// Loaded only in the presenter window, so the audience page does not ship it.
const PresenterView = lazy(() =>
  import("./presenter/PresenterView").then((m) => ({ default: m.PresenterView })),
);

// The phone remote loads no document and no deck: only its own small module.
const RemoteView = lazy(async () => {
  const [{ RemoteView: View }, { parseJoinFragment }] = await Promise.all([
    import("./remote/RemoteView"),
    import("./remote/crypto"),
  ]);
  const creds = parseJoinFragment(location.hash);
  return { default: () => <View creds={creds} /> };
});

createRoot(root).render(
  <StrictMode>
    {view === "presenter" ? (
      <Suspense fallback={null}>
        <PresenterView />
      </Suspense>
    ) : view === "remote" ? (
      <Suspense fallback={null}>
        <RemoteView />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
