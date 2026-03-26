import { setupHtml } from "./setupHtml";

function startApp() {
    setupHtml();
}

// Publish startApp
(window as any).startApp = startApp;