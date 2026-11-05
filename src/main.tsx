import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
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

// The editor and deck (reveal.js, the parser, the sample doc) load only in the
// main view, so the presenter window and the phone remote do not download them.
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));

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

// Service worker and update prompt (decision 11), main view of a production build only.
const PwaUpdates = lazy(() => import("./pwa/PwaUpdates").then((m) => ({ default: m.PwaUpdates })));

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
      <>
        <Suspense fallback={null}>
          <App />
        </Suspense>
        {import.meta.env.PROD && (
          <Suspense fallback={null}>
            <PwaUpdates />
          </Suspense>
        )}
      </>
    )}
  </StrictMode>,
);
