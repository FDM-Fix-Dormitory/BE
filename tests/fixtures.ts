import type { ManagementRepository } from '../src/repository.js';

const unexpected = async (): Promise<never> => { throw new Error('Unexpected repository access'); };
export const unavailableRepository: ManagementRepository = {
  findSession: async () => undefined, listReports: unexpected, findReport: unexpected,
  images: unexpected, confirm: unexpected, changeStatus: unexpected, notifications: unexpected,
};

import type { AuthReportRepository } from '../src/auth-report-repository.js';

export const unavailableAuthRepository: AuthReportRepository = {
  findCredentials: async () => undefined, createSession: unexpected, findSession: async () => undefined,
  revokeSession: unexpected, findUser: unexpected, createReport: unexpected, listMyReports: unexpected,
  findReportOwner: unexpected, addImages: unexpected, findImage: unexpected,
};
