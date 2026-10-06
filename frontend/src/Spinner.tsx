/**
 * Loading indicator (an indeterminate progress bar for screen readers).
 */

import { t } from "./i18n";

export const Spinner = (props: { small?: boolean; class?: string }) => (
  <div
    role="progressbar"
    class={`flex justify-center ${props.class ?? ""}`}
    aria-label={t("loading")}
  >
    <div
      class={`icon-[lucide--loader-circle] animate-spin text-orange-500 ${
        props.small ? "text-lg" : "text-3xl"
      }`}
      aria-hidden="true"
    />
  </div>
);
