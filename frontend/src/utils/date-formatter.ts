/**
 * Shared date formatting utilities for German locale (Berlin timezone).
 */

/**
 * Format a date in German locale with Berlin timezone.
 *
 * @param date - Date to format (Date object, ISO string, or timestamp).
 * @param style - Style options: 'full' (date + time), 'date', or 'time'.
 * @returns Formatted date string.
 */
export function formatGermanDate(
  date: Date | string | number,
  style: "full" | "date" | "time" = "full",
): string {
  const dateObj =
    typeof date === "string" || typeof date === "number"
      ? new Date(date)
      : date;

  // Configure Intl options; always use Berlin timezone and choose fields by style
  const options: Intl.DateTimeFormatOptions = {
    timeZone: "Europe/Berlin",
    // 'date' style: only date parts
    ...(style === "date"
      ? {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }
      : style === "time"
        ? {
            // 'time' style: only time parts (24h)
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }
        : {
            // default 'full': date + time (24h)
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }),
  };

  return dateObj.toLocaleString("de-DE", options);
}

/**
 * Format a date with both date and time style options.
 *
 * @param date - Date to format.
 * @param dateStyle - Date style (short, medium, long, full).
 * @param timeStyle - Time style (short, medium, long, full).
 * @returns Formatted date string.
 */
export function formatGermanDateTime(
  date: Date | string | number,
  dateStyle: "short" | "medium" | "long" | "full" = "short",
  timeStyle: "short" | "medium" | "long" | "full" = "medium",
): string {
  const dateObj =
    typeof date === "string" || typeof date === "number"
      ? new Date(date)
      : date;

  // Format using German locale and Berlin timezone with provided date/time styles
  return dateObj.toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    dateStyle,
    timeStyle,
  });
}
