import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { buildFcmAssertion } from "./fcm";

// The OAuth assertion is the part of the FCM flow we can verify hermetically (design §9):
// RS256-signed with the service account's key, correct issuer/audience/scope. The HTTP
// exchange itself is covered in test/db/notify.test.ts with an injected fetcher.

describe("buildFcmAssertion (design §9)", () => {
  it("signs a verifiable RS256 JWT with the firebase.messaging scope", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const assertion = await buildFcmAssertion({
      project_id: "test-project",
      client_email: "worker@test-project.iam.gserviceaccount.com",
      private_key: await exportPKCS8(privateKey),
    });
    const verifyKey = await importSPKI(await exportSPKI(publicKey), "RS256");
    const { payload, protectedHeader } = await jwtVerify(assertion, verifyKey, {
      issuer: "worker@test-project.iam.gserviceaccount.com",
      audience: "https://oauth2.googleapis.com/token",
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(payload.exp! - payload.iat!).toBe(3600);
  });
});
