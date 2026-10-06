/**
 * Date formatting in the current UI language (always Berlin time).
 */

import { locale } from "../i18n";

/**
 * Format a date with date and time style options.
 *
 * @param date - Date to format (Date object, ISO string, or timestamp).
 * @param dateStyle - Date style (short, medium, long, full).
 * @param timeStyle - Time style (short, medium, long, full).
 * @returns Formatted date string.
 */
export function formatDateTime(
  date: Date | string | number,
  dateStyle: "short" | "medium" | "long" | "full" = "short",
  timeStyle: "short" | "medium" | "long" | "full" = "medium",
): string {
  const dateObj = date instanceof Date ? date : new Date(date);
  return dateObj.toLocaleString(locale(), {
    timeZone: "Europe/Berlin",
    dateStyle,
    timeStyle,
  });
}
