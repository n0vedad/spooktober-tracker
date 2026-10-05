/**
 * One-time setup of the labeler account (run interactively by its owner):
 *
 *   pnpm --filter backend labeler-setup <did:key of LABELER_SIGNING_KEY>
 *
 * 1. Logs in as the labeler account (main password; app passwords cannot
 *    change the DID document).
 * 2. Publishes the app.bsky.labeler.service record with the label definitions.
 * 3. Adds the signing key (#atproto_label) and the labeler endpoint
 *    (#atproto_labeler) to the DID document via a PLC operation, confirmed
 *    with a code Bluesky sends to the account's email address.
 *
 * Password and email code only travel between this machine and the PDS.
 * Safe to re-run: the record is overwritten, the PLC step is skipped when the
 * DID document is already up to date.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { LABEL_DEFINITIONS } from "../src/labeler/policy.js";

const LABELER_DID = "did:plc:h5wgui5fkurmgeno5mcpqfgv";
const LABELER_ENDPOINT = "https://spooktober.katerstrophal.world";

const didKey = process.argv[2];
if (!didKey?.startsWith("did:key:z")) {
  console.error("Usage: pnpm labeler-setup <did:key of the signing key>");
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });

// Ask without echoing the answer (for the password)
async function askHidden(question: string): Promise<string> {
  const write = stdout.write.bind(stdout);
  const pending = rl.question(question);
  (stdout as { write: unknown }).write = (chunk: string | Uint8Array) =>
    typeof chunk === "string" && chunk.includes(question) ? write(chunk) : true;
  try {
    return await pending;
  } finally {
    stdout.write = write;
    stdout.write("\n");
  }
}

// Current DID document data from the PLC directory
async function plcData() {
  const res = await fetch(`https://plc.directory/${LABELER_DID}/data`);
  if (!res.ok) throw new Error(`plc.directory: ${res.status}`);
  return (await res.json()) as {
    verificationMethods: Record<string, string>;
    services: Record<string, { type: string; endpoint: string }>;
  };
}

async function main() {
  const data = await plcData();
  const pds = data.services.atproto_pds.endpoint;
  console.log(`Labeler ${LABELER_DID} (PDS ${pds})\n`);

  // XRPC call against the account's PDS
  let accessJwt = "";
  async function xrpc(method: "GET" | "POST", nsid: string, body?: unknown) {
    const res = await fetch(`${pds}/xrpc/${nsid}`, {
      method,
      headers: {
        ...(accessJwt && { Authorization: `Bearer ${accessJwt}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${nsid}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  // 1. Login
  const password = await askHidden("Password of the labeler account: ");
  const session = await xrpc("POST", "com.atproto.server.createSession", {
    identifier: LABELER_DID,
    password,
  });
  accessJwt = session.accessJwt;
  console.log(`✅ Logged in as @${session.handle}`);

  // 2. Labeler service record
  await xrpc("POST", "com.atproto.repo.putRecord", {
    repo: LABELER_DID,
    collection: "app.bsky.labeler.service",
    rkey: "self",
    record: {
      $type: "app.bsky.labeler.service",
      policies: {
        labelValues: LABEL_DEFINITIONS.map((d) => d.identifier),
        labelValueDefinitions: LABEL_DEFINITIONS.map((d) => ({
          identifier: d.identifier,
          severity: "inform",
          blurs: "none",
          defaultSetting: "warn",
          adultOnly: false,
          locales: d.locales,
        })),
      },
      subjectTypes: ["account"],
      createdAt: new Date().toISOString(),
    },
  });
  console.log("✅ Published the labeler service record");

  // 3. DID document: signing key + labeler endpoint
  const upToDate =
    data.verificationMethods.atproto_label === didKey &&
    data.services.atproto_labeler?.endpoint === LABELER_ENDPOINT;
  if (upToDate) {
    console.log(
      "✅ DID document already contains the labeler key and endpoint",
    );
    return;
  }

  await xrpc("POST", "com.atproto.identity.requestPlcOperationSignature");
  console.log("📧 Bluesky sent a confirmation code to the account's email.");
  const token = (await rl.question("Code from the email: ")).trim();

  const { operation } = await xrpc(
    "POST",
    "com.atproto.identity.signPlcOperation",
    {
      token,
      verificationMethods: {
        ...data.verificationMethods,
        atproto_label: didKey,
      },
      services: {
        ...data.services,
        atproto_labeler: {
          type: "AtprotoLabeler",
          endpoint: LABELER_ENDPOINT,
        },
      },
    },
  );
  await xrpc("POST", "com.atproto.identity.submitPlcOperation", { operation });

  const after = await plcData();
  if (
    after.verificationMethods.atproto_label !== didKey ||
    after.services.atproto_labeler?.endpoint !== LABELER_ENDPOINT
  ) {
    throw new Error("PLC directory does not show the new entries yet");
  }
  console.log("✅ DID document now contains the labeler key and endpoint");
}

main()
  .then(() => console.log("\n🎃 Labeler setup complete."))
  .catch((error) => {
    console.error(`\n❌ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
