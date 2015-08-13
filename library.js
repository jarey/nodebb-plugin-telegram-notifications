"use strict";

var db = module.parent.require('./database'),
	meta = module.parent.require('./meta'),
	user = module.parent.require('./user'),
	posts = module.parent.require('./posts'),
	topics = module.parent.require('./topics'),
	SocketPlugins = module.parent.require('./socket.io/plugins'),
	winston = module.parent.require('winston'),
	nconf = module.parent.require('nconf'),
	async = module.parent.require('async'),
	S = module.parent.require('string'),
	cache = require('lru-cache'),
	lang_cache,
	translator = module.parent.require('../public/src/modules/translator'),

	Telegram = {};
var SocketAdmins = module.parent.require('./socket.io/admin');

var TelegramBot = require('node-telegram-bot-api');

var token = null;
var message = null;
var bot = null;

Telegram.init = function(params, callback) {
	var middleware = params.middleware,
	controllers = params.controllers;
	// Prepare templates
	controllers.getTelegramBotAdmin = function (req, res, next) {
		// Renderiza la plantilla
		res.render('admin/plugins/telegrambot', {});
	};
	controllers.getTelegramBotSettings = function (req, res, next) {
		// Renderiza la plantilla
		bot.getMe().then(function(me){
			res.render('telegrambot/settings', {botname:me.username});
		});
	};

	// Create urls
	params.router.get('/admin/telegrambot', middleware.buildHeader, controllers.getTelegramBotAdmin);
	params.router.get('/api/admin/telegrambot', controllers.getTelegramBotAdmin);
	params.router.get('/telegram/settings', middleware.buildHeader, controllers.getTelegramBotSettings);
	params.router.get('/api/telegram/settings', controllers.getTelegramBotSettings);

	// User language cache
	db.getObjectField('global', 'userCount', function(err, numUsers) {
		var	cacheOpts = {
				max: 50,
				maxAge: 1000 * 60 * 60 * 24
			};

		if (!err && numUsers > 0) {
			cacheOpts.max = Math.floor(numUsers / 20);
		}
		lang_cache = cache(cacheOpts);
	});

	// Prepare bot
	db.getObject('telegrambot-token', function(err, t){
		if(err || !t)
		{
			return callback();
		}

		token = t.token;
		message = t.msg;
		// Setup polling way
		bot = new TelegramBot(token, {polling: true});

		bot.on('text', function (msg) {
			var chatId = msg.chat.id;
			var userId = msg.from.id;
			var username = msg.from.username;
			if(!message)
			{
				message = "Your Telegram ID: {userid}";
			}
			message = message.replace("{userid}", userId);
			bot.sendMessage(chatId, message);
		});


		callback();
	});
};

Telegram.getUserLanguage = function(uid, callback) {
	if (lang_cache && lang_cache.has(uid)) {
		callback(null, lang_cache.get(uid));
	} else {
		user.getSettings(uid, function(err, settings) {
			var language = settings.language || meta.config.defaultLang || 'en_GB';
			callback(null, language);
			lang_cache.set(uid, language);
		});
	}
};

Telegram.pushNotification = function(data) {
	var notifObj = data.notification;
	var uids = data.uids;

	//console.log(data);

	if (!Array.isArray(uids) || !uids.length || !notifObj)
	{
		return;
	}

	if(notifObj.nid && notifObj.nid.indexOf("post_flag") > -1)
	{	// Disable notifications from flags.
		return;
	}

	// Send notification for each user.
	user.getMultipleUserFields(uids, ["telegramid"], function(err, usersData){
		//console.log(usersData);
		for(var i in usersData)
		{
			var telegramId = usersData[i].telegramid;
			var uid = usersData[i].uid;

			async.waterfall([
				function(next){
					// Get user language
					Telegram.getUserLanguage(uid, next);
				},
				function(lang, next) {
					// Prepare notification with the user language
					notifObj.bodyLong = notifObj.bodyLong || '';
					notifObj.bodyLong = S(notifObj.bodyLong).unescapeHTML().stripTags().unescapeHTML().s;
					async.parallel({
						title: function(next) {
							translator.translate(notifObj.bodyShort, lang, function(translated) {
								next(undefined, S(translated).stripTags().s);
							});
						},
						postIndex: async.apply(posts.getPidIndex, notifObj.pid, uid),
						topicSlug: async.apply(topics.getTopicFieldByPid, 'slug', notifObj.pid)
					}, next);
				},
				function(data, next) {
					// Send notification
					/*
					var	payload = {
							device_iden: settings['pushbullet:target'] && settings['pushbullet:target'].length ? settings['pushbullet:target'] : null,
							type: 'link',
							title: data.title,
							url: notifObj.path || nconf.get('url') + '/topic/' + data.topicSlug + '/' + data.postIndex,
							body: notifObj.bodyLong
						};
					*/
					var title = data.title;
					var url = notifObj.path || nconf.get('url') + '/topic/' + data.topicSlug + '/' + data.postIndex;
					var body = title + "\n\n" + notifObj.bodyLong + "\n\n" + url;

					winston.verbose('[plugins/telegram] Sending notification to uid ' + uid);
					bot.sendMessage(telegramId, body);
				}
			]);
		}
	});
};

// Add button in profile
Telegram.addProfileItem = function(links, callback) {
	if (token) {
		links.push({
			id: 'telegram',
			route: '../../telegram/settings',
			icon: 'fa-mobile',
			name: 'Telegram',
			public: false
		});
	}

	callback(null, links);
};

Telegram.addNavigation = function(custom_header, callback) {
// Añadimos al menu de admin el acceso a ver los registros
	custom_header.plugins.push({
		route: '/telegrambot',
		icon: '',
		name: 'Telegram Notifications'
	});

	callback(null, custom_header);
}


// Sockets
SocketAdmins.setTelegramToken = function (socket, data, callback)
{
	var t = {token:data.token, msg:data.msg};
	db.setObject('telegrambot-token', data, callback);
}

SocketAdmins.getTelegramToken = function (socket, data, callback)
{
	db.getObject('telegrambot-token', callback);
}

SocketPlugins.setTelegramID = function (socket, data, callback)
{
	user.setUserField(socket.uid, "telegramid", data, callback);
}

SocketPlugins.getTelegramID = function (socket, data, callback)
{
	user.getUserField(socket.uid, "telegramid", callback);
}


module.exports = Telegram;