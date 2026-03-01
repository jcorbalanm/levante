import { ENV_DEFAULTS } from '../../shared/envDefaults';

class EnvConfig {
  private get defaults() {
    return process.env.NODE_ENV === 'production'
      ? ENV_DEFAULTS.production
      : ENV_DEFAULTS.development;
  }

  get platformUrl(): string {
    return process.env.LEVANTE_PLATFORM_URL || this.defaults.LEVANTE_PLATFORM_URL;
  }

  get servicesHost(): string {
    return (process.env.LEVANTE_SERVICES_HOST || this.defaults.LEVANTE_SERVICES_HOST)
      .replace(/\/$/, '');
  }
}

export const envConfig = new EnvConfig();
