declare module "*.mdx" {
  const Component: (props: { components?: Record<string, unknown> }) => import("react").ReactNode;
  export default Component;
}
