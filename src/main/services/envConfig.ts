import { ENV_DEFAULTS } from '../../shared/envDefaults';

class EnvConfig {
  get platformUrl(): string {
    return ENV_DEFAULTS.production.LEVANTE_PLATFORM_URL;
  }

  get servicesHost(): string {
    return ENV_DEFAULTS.production.LEVANTE_SERVICES_HOST;
  }
}

export const envConfig = new EnvConfig();
