export type LinkRequestStatus = 'pending' | 'approved' | 'denied';

export interface LinkRequest {
  id: string;
  requesterId: string;
  requesterDevice: string;
  requesterIp: string;
  targetUserId: string;
  status: LinkRequestStatus;
  createdAt: string;
}
