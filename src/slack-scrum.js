// Description:
//   [description]
//
// Dependencies:
//   hubot-slack
//   jade
//   mandrill-api
//
// Configuartion:
//   HSS_QUESTION_FIRST
//   HSS_QUESTION_SECOND
//   HSS_QUESTION_THIRD
//   HSS_MANDRILL_API_KEY
//
// Commands:
//   hubot scrum start <email> <project>
//   next
//   next user <reason>
//
// Author:
//   @eseceve

var env = process.env;

var QUESTIONS = [
  env.HSS_QUESTION_FIRST ||
    'What did you do yesterday that helped the development team meet the' +
    ' sprint goal?',
  env.HSS_QUESTION_SECOND ||
    'What will you do today to help the development team meet the sprint goal?',
  env.HSS_QUESTION_THIRD ||
    'Do you see any impediment that prevents me or the development team from' +
    ' meeting the sprint goal?'
];

var jade = require('jade');
var mandrill = require('mandrill-api/mandrill');


module.exports = function scrum(robot) {
  var slackAdapterClient = robot.adapter.client;


  robot.respond(/scrum start(\s([a-zA-Z0-9+._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))?/i, start);
  robot.hear(/scrum project(.*)/i, updateProjectName)
  robot.hear(/next/i, next);
  robot.hear(/next user(.*)/i, nextUser);


  function start(res) {
    var channel = _getChannel(res.message.room);
    var email = res.match[2];
    
    var scrum;

    if (_scrumExists(channel)) return;
    scrum = _getScrum(channel);
    res.send("Hi " + res.message.room + ", let's start a new scrum session!");
    res.send("But before you start please tell me for which project is this scrum intented!");

    if (email) {
      scrum.email = email;
    }
    	
    robot.brain.set(_getScrumID(channel), scrum);

    _doQuestion(scrum);
  }
  
  function updateProjectName(res) {
	    var channel = _getChannel(res.message.room);
	    var text = res.message.text.toLowerCase();
	    var name;
	    var scrum;
	    var user;

	    if (!_scrumExists(channel)) return;

	    scrum = _getScrum(channel);
	    projectName = res.match[1];


	    if (name) {
	      scrum.name = name.trim();
	      robot.brain.set(_getScrumID(scrum.channel), scrum);
	    }
	  }


  function next(res, force) {
    var channel = _getChannel(res.message.room);
    var scrum;

    if (!_scrumExists(channel)) return;
    if (!force && res.message.text.toLowerCase().trim() !== 'next') return;

    scrum = _getScrum(channel);

    if (scrum.question === QUESTIONS.length) return nextUser(res, true);
    _doQuestion(scrum);
  }


  function nextUser(res, force) {
    var channel = _getChannel(res.message.room);
    var text = res.message.text.toLowerCase();
    var reason;
    var scrum;
    var user;

    if (!_scrumExists(channel)) return;

    scrum = _getScrum(channel);
    reason = res.match[1];

    if (!force) {
      if (text.indexOf('next user') !== 0 || !scrum) return;
      if (!reason) return res.send(
        'Command `next user <reason>` require a <reason>');
    }

    if (reason) {
      scrum.members[scrum.user].reason = reason.trim();
      robot.brain.set(_getScrumID(scrum.channel), scrum);
    } else {
      _saveAnswer(scrum);
    }

    scrum.user++;
    scrum.question = 0;
    if (scrum.user >= scrum.members.length) return _finish(scrum);
    next(res, true);
  }


  function _createScrum(channel) {
    var history = Object.keys(channel.getHistory()).reverse();
    var scrum = {
      answers: {},
      channel: channel,
      lastMessageTS: history[0],
      question: 0,
      reasons: {},
      user: 0
    };

    scrum.members = channel.members.map(function getUserObject(userID) {
      var user = slackAdapterClient.getUserByID(userID);
      user.reason = '';
      user.answers = [];
      return user;
    }).filter(function filterBots(user) {
      return !user.is_bot;
    });

    return scrum;
  }


  function _doQuestion(scrum) {
    var user = scrum.members[scrum.user];
    var message = '<@' + user.id + '> ' + QUESTIONS[scrum.question];

    _saveAnswer(scrum);
    scrum.channel.send(message);
    scrum.question++;
  }


  function _finish(scrum) {
    _saveAnswer(scrum);
    scrum.channel.send("Thanks <!channel> for participating in today's scrum");
    scrum.channel.send("If you have any questions about this module send an email to: <ismirha@maestralsolutions.com>");
    _sendEmail(scrum);
    robot.brain.set(_getScrumID(scrum.channel), false);
  }


  function _getChannel(roomName) {
    var channel = slackAdapterClient.getChannelByName(roomName);

    if (!channel) channel = slackAdapterClient.getGroupByName(roomName);
    if (!channel) throw new Error('Room must be a channel or group');

    return channel;
  }


  function _getScrum(channel) {
    var scrum;

    if (_scrumExists(channel)) return robot.brain.get(_getScrumID(channel));

    scrum = _createScrum(channel);
    robot.brain.set(_getScrumID(channel), scrum);

    return scrum;
  }


  function _getScrumID(channel) {
    return 'HSS-'+channel.id;
  }


  function _saveAnswer(scrum) {
    var firstMessage = true;
    var history = scrum.channel.getHistory();
    var noMore = false;
    var user = scrum.members[scrum.user];
    var lastMessageTS;

    if (!user || !scrum.question) return;

    user.answers[scrum.question-1] = Object.keys(history)
      .reverse()
      .filter(function checkMessage(messageTS) {
        var message = history[messageTS];
        var filtered = true;

        if (firstMessage) {
          lastMessageTS = messageTS;
          firstMessage = false;
          return false;
        }
        if (noMore) return false;
        if (!message) return false;
        if (message.user !== user.id) return false;

        if (message.text.indexOf('next') === 0 ||
          scrum.lastMessageTS === messageTS) {
          noMore = true;
          filtered = false;
        }

        return filtered;
      })
      .map(function getText(messageTS) {
        return history[messageTS].text.trim();
      })
      .reverse();

    scrum.lastMessageTS = lastMessageTS;
    scrum.members[scrum.user] = user;
    robot.brain.set(_getScrumID(scrum.channel), scrum);
  }


  function _scrumExists(channel) {
    return !!robot.brain.get(_getScrumID(channel));
  }


  function _sendEmail(scrum) {
    if (!scrum.email) return;
    if (!env.HSS_MANDRILL_API_KEY) return;

    var mandrillClient = new mandrill.Mandrill(env.HSS_MANDRILL_API_KEY);
    var html = jade.compileFile(__dirname + '/email.jade')({
      questions: QUESTIONS,
      members: scrum.members
    });

    mandrillClient.messages.send({
      message: {
        html: html,
        subject: scrum.name + " scrum meeting " + new Date().toLocaleDateString(),
        from_email: "no.replay@maestralsolutions.com",
        from_name: scrum.name + " Slack Scrum",
        to: [{
          email: scrum.email,
          type: "to"
        }]
      },
    });
  }
};
