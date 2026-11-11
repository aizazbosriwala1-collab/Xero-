export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramReplyKeyboardMarkup {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export type FsmStep =
  | 'IDLE'
  | 'AWAITING_SEARCH_QUERY'
  | 'AWAITING_EMAIL_FOR_ORDER'
  | 'AWAITING_BINANCE_AMOUNT'
  | 'AWAITING_BINANCE_TXID'
  | 'AWAITING_MANUAL_AMOUNT'
  | 'AWAITING_MANUAL_TXID'
  | 'AWAITING_MANUAL_PROOF'
  | 'AWAITING_SUPPORT_MESSAGE'
  | 'ADMIN_AWAITING_PRICE_PRODUCT'
  | 'ADMIN_AWAITING_PRICE_VALUE';

export interface UserFsmState {
  step: FsmStep;
  data?: Record<string, any>;
}
