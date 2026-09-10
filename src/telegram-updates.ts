export interface TelegramUser {
	id: number;
	username?: string;
	is_bot?: boolean;
	first_name?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

export interface TelegramFileAttachment {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	media_group_id?: string;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramFileAttachment;
	video?: TelegramFileAttachment;
	audio?: TelegramFileAttachment;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}
