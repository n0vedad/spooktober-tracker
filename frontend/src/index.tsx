/* @refresh reload */

/**
 * Frontend entrypoint: imports global styles and mounts the Solid app.
 *
 * - Imports `index.css` which wires Tailwind v4 and custom theme tokens.
 * - Mounts the root `App` component into the `<body id="root">` element.
 */

// Entrypoint that mounts the Solid application into the DOM.
import { render } from "solid-js/web";
import App from "./App";
import "./index.css";

// Render App
render(() => <App />, document.getElementById("root") as HTMLElement);
