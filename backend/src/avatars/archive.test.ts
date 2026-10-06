import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import { purgeAccount } from "../db.js";
import { createAvatarArchive, thumbnailUrl } from "./archive.js";
import { getThumb, hasThumb, saveThumb } from "./store.js";

const ALICE = "did:plc:alice";
const OLD = "bafkreiold";
const NEW = "bafkreinew";

const image = (bytes: number[]) =>
  new Response(new Uint8Array(bytes), {
    headers: { "content-type": "image/jpeg" },
  });

beforeEach(resetDB);

describe("avatar archive", () => {
  it("archives the old and the new avatar of a change", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes(OLD) ? image([1, 2]) : image([3]),
    );
    const archive = createAvatarArchive({
      has: hasThumb,
      save: saveThumb,
      fetch: fetch as typeof globalThis.fetch,
    });

    archive.onChange({ did: ALICE, old_avatar: OLD, new_avatar: NEW });
    await archive.idle();

    expect(fetch).toHaveBeenCalledWith(
      thumbnailUrl(ALICE, OLD),
      expect.anything(),
    );
    expect((await getThumb(ALICE, OLD))?.data).toEqual(Buffer.from([1, 2]));
    expect(await getThumb(ALICE, NEW)).toMatchObject({
      content_type: "image/jpeg",
    });
  });

  it("skips avatars it already has and ones the CDN no longer serves", async () => {
    await saveThumb(ALICE, NEW, {
      data: Buffer.from([9]),
      content_type: "image/jpeg",
    });
    const fetch = vi.fn(async () => new Response("gone", { status: 404 }));
    const archive = createAvatarArchive({
      has: hasThumb,
      save: saveThumb,
      fetch: fetch as typeof globalThis.fetch,
    });

    archive.onChange({ did: ALICE, old_avatar: OLD, new_avatar: NEW });
    await archive.idle();

    expect(fetch).toHaveBeenCalledOnce();
    expect(await hasThumb(ALICE, OLD)).toBe(false);
  });

  it("ignores non-images and survives fetch errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>"))
      .mockRejectedValue(new Error("timeout"));
    const archive = createAvatarArchive({
      has: hasThumb,
      save: saveThumb,
      fetch,
      retryDelayMs: 10,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    archive.onChange({ did: ALICE, old_avatar: OLD, new_avatar: NEW });
    await archive.idle();

    expect(await hasThumb(ALICE, OLD)).toBe(false);
    expect(await hasThumb(ALICE, NEW)).toBe(false);
  });

  it("tries once more after a timeout or server error", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("The operation was aborted due to timeout"),
      )
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      // A fresh response per call: a body can only be read once
      .mockImplementation(async () => image([7]));
    const archive = createAvatarArchive({
      has: hasThumb,
      save: saveThumb,
      fetch,
      retryDelayMs: 10,
    });

    archive.onChange({ did: ALICE, old_avatar: OLD, new_avatar: NEW });
    await archive.idle();

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await hasThumb(ALICE, OLD)).toBe(true);
    expect(await hasThumb(ALICE, NEW)).toBe(true);
  });

  it("gives up after the second failure", async () => {
    const fetch = vi.fn(async () => new Response("busy", { status: 502 }));
    const archive = createAvatarArchive({
      has: hasThumb,
      save: saveThumb,
      fetch: fetch as typeof globalThis.fetch,
      retryDelayMs: 10,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    archive.onChange({ did: ALICE, old_avatar: null, new_avatar: NEW });
    await archive.idle();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(await hasThumb(ALICE, NEW)).toBe(false);
  });

  it("does nothing for changes without a new avatar", async () => {
    const fetch = vi.fn();
    const archive = createAvatarArchive({
      has: hasThumb,
      save: saveThumb,
      fetch,
    });

    archive.onChange({ did: ALICE, old_avatar: OLD, new_avatar: OLD });
    await archive.idle();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("is removed with the account's data", async () => {
    await saveThumb(ALICE, OLD, {
      data: Buffer.from([1]),
      content_type: "image/jpeg",
    });

    await purgeAccount(ALICE);

    expect(await hasThumb(ALICE, OLD)).toBe(false);
  });
});
