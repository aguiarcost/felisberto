import { Env, json, preflight, createAdminToken } from "../_shared";

// POST /api/admin-login  { password } -> { token }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    if (!env.ADMIN_PASSWORD) {
      return json(
        {
          error:
            "ADMIN_PASSWORD não está configurado. Adicione-o como Secret em Cloudflare Pages → Settings → Variables and Secrets e faça novo deploy.",
        },
        503
      );
    }

    const { password } = (await request.json()) as { password?: string };
    if (!password || typeof password !== "string") {
      return json({ error: "Password em falta" }, 400);
    }

    // Small constant delay to blunt brute-force attempts.
    await new Promise((r) => setTimeout(r, 400));

    if (password !== env.ADMIN_PASSWORD) {
      return json({ error: "Password incorreta" }, 401);
    }

    const token = await createAdminToken(env);
    return json({ token });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro interno" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();
