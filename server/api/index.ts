// Vercel runs this file as a plain Node module, which cannot resolve the
// extensionless imports in src/. The build bundles src/function.ts into dist/.
const bundle = "../dist/milton.js";
const { default: handler } = (await import(bundle)) as {
  default: { fetch(request: Request): Promise<Response> };
};
export default handler;
