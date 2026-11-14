export type ButtonStyle = 'primary' | 'success' | 'danger' | 'default';
export type TelegramApiButtonStyle = 'primary' | 'success' | 'danger';

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
  style?: TelegramApiButtonStyle;
  icon_custom_emoji_id?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramReplyKeyboardButton {
  text: string;
  style?: TelegramApiButtonStyle;
  icon_custom_emoji_id?: string;
}

export interface TelegramReplyKeyboardMarkup {
  keyboard: Array<Array<TelegramReplyKeyboardButton>>;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export type TelegramBotCommandScope =
  | { type: 'default' }
  | { type: 'all_private_chats' }
  | { type: 'chat'; chat_id: number | string };

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
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
  | 'AWAITING_MANUAL_PHONE'
  | 'AWAITING_SUPPORT_MESSAGE'
  | 'ADMIN_AWAITING_PRICE_PRODUCT'
  | 'ADMIN_AWAITING_PRICE_VALUE'
  | 'ADMIN_UI_EDIT_TEXT'
  | 'ADMIN_UI_EDIT_EMOJI'
  | 'ADMIN_UI_IMPORT_JSON'
  | 'ADMIN_UI_CONFIRM_RESET_ALL'
  | 'ADMIN_BINANCE_DIAG_ORDER_ID'
  | 'ADMIN_SUPPLIER_DIAG_ORDER_REF'
  | 'ADMIN_GW_CREATE_STEP'
  | 'ADMIN_GW_EDIT_VALUE'
  | 'ADMIN_REF_CREATE_STEP'
  | 'ADMIN_REF_EDIT_VALUE'
  | 'ADMIN_REF_SETTINGS_VALUE'
  | 'ADMIN_CH_ADD_INPUT'
  | 'ADMIN_SETTINGS_VALUE'
  | 'ADMIN_DEP_CUSTOM_USD'
  | 'ADMIN_DEP_SETTINGS_VALUE';

export interface UserFsmState {
  step: FsmStep;
  data?: Record<string, any>;
}
