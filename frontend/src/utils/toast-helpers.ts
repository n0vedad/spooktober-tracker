/**
 * Custom toast helpers with consistent styling.
 *
 * Provides thin wrappers around `solid-toast` so success/error toasts
 * look uniform across the application. Prefer these helpers over
 * calling `toast.*` directly to keep a consistent UI.
 */

import type { ToastOptions } from "solid-toast";
import toast from "solid-toast";

// Success toast visual appearance
const successStyle = {
  background: "#22c55e",
  color: "#fff",
};
const successIconTheme = {
  primary: "#fff",
  secondary: "#22c55e",
};

// Error toast visual appearance
const errorStyle = {
  background: "#ef4444",
  color: "#fff",
};
const errorIconTheme = {
  primary: "#fff",
  secondary: "#ef4444",
};

/**
 * Show a success toast with consistent styling.
 *
 * @param message Human‑readable text to display.
 * @param options Optional overrides for `solid-toast` behavior.
 * @returns Toast ID (from `solid-toast`).
 */
export const showSuccess = (message: string, options?: ToastOptions) => {
  return toast.success(message, {
    style: successStyle,
    iconTheme: successIconTheme,
    ...options,
  });
};

/**
 * Show an error toast with consistent styling.
 *
 * @param message Human‑readable text to display.
 * @param options Optional overrides for `solid-toast` behavior.
 * @returns Toast ID (from `solid-toast`).
 */
export const showError = (message: string, options?: ToastOptions) => {
  return toast.error(message, {
    style: errorStyle,
    iconTheme: errorIconTheme,
    ...options,
  });
};
