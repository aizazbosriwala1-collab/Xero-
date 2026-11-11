import { db } from '../db/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('SupportService');

export interface SupportTicket {
  id: string;
  userId: string;
  orderId?: string;
  issueType: string;
  subject: string;
  status: 'OPEN' | 'WAITING' | 'RESOLVED' | 'CLOSED';
  createdAt: string;
  messages: Array<{
    id: string;
    senderType: 'CUSTOMER' | 'ADMIN';
    senderId: string;
    message: string;
    attachmentFileId?: string;
    createdAt: string;
  }>;
}

export class SupportService {
  /**
   * Create a new support ticket
   */
  public async createTicket(params: {
    userId: string;
    orderId?: string;
    issueType: string;
    subject: string;
    message: string;
    attachmentFileId?: string;
  }): Promise<string> {
    const ticketId = `tkt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO support_tickets (id, user_id, order_id, issue_type, subject, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'OPEN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [ticketId, params.userId, params.orderId || null, params.issueType, params.subject]);

      await client.query(`
        INSERT INTO support_messages (id, ticket_id, sender_type, sender_id, message, attachment_file_id, created_at)
        VALUES ($1, $2, 'CUSTOMER', $3, $4, $5, CURRENT_TIMESTAMP)
      `, [msgId, ticketId, params.userId, params.message, params.attachmentFileId || null]);
    });

    logger.info('Support ticket created', { ticketId, userId: params.userId, issueType: params.issueType });
    return ticketId;
  }

  /**
   * Add a message to an existing ticket
   */
  public async addMessage(params: {
    ticketId: string;
    senderType: 'CUSTOMER' | 'ADMIN';
    senderId: string;
    message: string;
    attachmentFileId?: string;
  }): Promise<void> {
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newStatus = params.senderType === 'ADMIN' ? 'WAITING' : 'OPEN';

    await db.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO support_messages (id, ticket_id, sender_type, sender_id, message, attachment_file_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      `, [msgId, params.ticketId, params.senderType, params.senderId, params.message, params.attachmentFileId || null]);

      await client.query(`
        UPDATE support_tickets
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [newStatus, params.ticketId]);
    });
  }

  /**
   * Get customer tickets with message history
   */
  public async getUserTickets(userId: string): Promise<SupportTicket[]> {
    const ticketsRes = await db.query<any>(`
      SELECT id, user_id as "userId", order_id as "orderId", issue_type as "issueType",
             subject, status, created_at as "createdAt"
      FROM support_tickets
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 10
    `, [userId]);

    const tickets: SupportTicket[] = [];
    for (const t of ticketsRes.rows) {
      const msgsRes = await db.query<any>(`
        SELECT id, sender_type as "senderType", sender_id as "senderId",
               message, attachment_file_id as "attachmentFileId", created_at as "createdAt"
        FROM support_messages
        WHERE ticket_id = $1
        ORDER BY created_at ASC
      `, [t.id]);

      tickets.push({
        id: t.id,
        userId: t.userId,
        orderId: t.orderId,
        issueType: t.issueType,
        subject: t.subject,
        status: t.status,
        createdAt: t.createdAt,
        messages: msgsRes.rows,
      });
    }

    return tickets;
  }
}

export const supportService = new SupportService();
