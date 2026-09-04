export class ToxiproxyHelper {
  constructor(private readonly baseUrl = process.env.TOXIPROXY_URL ?? 'http://127.0.0.1:8474') {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/version`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureProxy(name: string, listen: string, upstream: string): Promise<void> {
    try {
      const getRes = await fetch(`${this.baseUrl}/proxies/${name}`);
      if (getRes.ok) {
        await this.enable(name);
        return;
      }
    } catch {
      // proxy might not exist yet
    }

    await fetch(`${this.baseUrl}/proxies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, listen, upstream, enabled: true }),
    });
  }

  async disable(name: string): Promise<void> {
    await fetch(`${this.baseUrl}/proxies/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
  }

  async enable(name: string): Promise<void> {
    await fetch(`${this.baseUrl}/proxies/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  }
}
