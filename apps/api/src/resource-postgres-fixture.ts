import { randomBytes, randomUUID } from "node:crypto";
import { authInstanceState, type Database } from "@task-weaver/db";
import { createAuthenticationService, createIdentityManagementService } from "@task-weaver/core";
import type { VerifiedRequestContext } from "@task-weaver/contracts";
import { createApiApplication } from "./application";

type Authentication = ReturnType<typeof createAuthenticationService>;
type UserFixture = { headers: Headers; account: Awaited<ReturnType<Authentication["login"]>>["account"]; context: VerifiedRequestContext };
type ResourceFixture = { auth: Authentication; identity: ReturnType<typeof createIdentityManagementService>;
  admin: UserFixture; owner: UserFixture; outsider: UserFixture;
  project: Awaited<ReturnType<ReturnType<typeof createIdentityManagementService>["createProject"]>>;
  app: ReturnType<typeof createApiApplication>["app"] };

/** Fixture credentials and state exist only in the caller's disposable test database. */
export async function resourcePostgresFixture(db: Database, databaseUrl: string): Promise<ResourceFixture> {
  await db.update(authInstanceState).set({ initializedByUserId: null, initializedAt: null });
  const config = { secret: randomBytes(32).toString("hex"), bootstrapSecret: randomBytes(32).toString("hex"),
    baseURL: "http://127.0.0.1:3001", trustedOrigins: ["http://127.0.0.1:3000"] };
  const auth = createAuthenticationService(db, config);
  const identity = createIdentityManagementService(db, auth);
  const password = randomBytes(24).toString("hex");
  const client = () => {
    const csrf = auth.csrfChallenge();
    return new Headers({ origin: config.trustedOrigins[0]!, "x-csrf-token": csrf.csrfToken,
      cookie: csrf.headers.getSetCookie().map(c => c.split(";")[0]).join("; "), "content-type": "application/json" });
  };
  const login = async (email: string) => {
    const headers = client();
    const result = await auth.login(headers, { email, password }, randomUUID());
    headers.set("cookie", [headers.get("cookie"), ...result.headers.getSetCookie().map(c => c.split(";")[0])].join("; "));
    return { headers, account: result.account, context: await auth.resolve(headers) };
  };
  const email = `${randomUUID()}@example.test`;
  await auth.bootstrap(client(), { email, password, displayName: "Test administrator", bootstrapSecret: config.bootstrapSecret }, randomUUID());
  const admin = await login(email);
  const human = async () => {
    const email = `${randomUUID()}@example.test`;
    const invite = await auth.provision(admin.headers, { email, displayName: "Test member" });
    await auth.activate(client(), { token: invite.activationToken, password }, randomUUID());
    return login(email);
  };
  const owner = await human(), outsider = await human();
  const project = await identity.createProject(owner.headers, { name: "Private test project" });
  const app = createApiApplication({ db, databaseUrl, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BASE_URL: config.baseURL,
    TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  return { auth, identity, admin, owner, outsider, project, app };
}
