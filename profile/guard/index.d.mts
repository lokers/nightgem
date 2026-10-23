declare const guard: {
  id: string;
  setup(ctx: {
    tool: { hook(name: string, fn: (event: Record<string, unknown>) => Promise<void>): Promise<void> | void };
  }): Promise<void>;
};
export default guard;
