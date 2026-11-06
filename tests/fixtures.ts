import type { ManagementRepository } from '../src/repository.js';

const unexpected = async (): Promise<never> => { throw new Error('Unexpected repository access'); };
export const unavailableRepository: ManagementRepository = {
  findSession: async () => undefined, listReports: unexpected, findReport: unexpected,
  images: unexpected, confirm: unexpected, changeStatus: unexpected, notifications: unexpected,
};
