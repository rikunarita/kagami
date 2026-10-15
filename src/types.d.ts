declare module "satoru-render/satoru.js" {
  const factory: (moduleOptions?: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
