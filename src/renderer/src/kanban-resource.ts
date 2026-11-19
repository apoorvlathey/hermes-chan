export interface ResourceState<T> { loading: boolean; data?: T; error?: string }

/** One request generation per resource, so switching boards/hosts cannot leak stale results. */
export class Resource<T> {
  state: ResourceState<T> = { loading: false }
  private generation = 0
  constructor(private changed: (state: ResourceState<T>) => void = () => {}) {}
  clear() { this.generation++; this.publish({ loading: false }) }
  private publish(state: ResourceState<T>) { this.state = state; this.changed(state) }
  async load(read: () => Promise<T>) {
    const generation = ++this.generation
    this.publish({ loading: true })
    try {
      const data = await read()
      if (generation === this.generation) this.publish({ loading: false, data })
    } catch (error) {
      if (generation === this.generation) this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
