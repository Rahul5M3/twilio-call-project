const express = require('express');
const twilio = require('twilio');
const bodyParser = require('body-parser');
// const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');
const { start } = require('repl');
const { Conversation } = require('twilio/lib/twiml/VoiceResponse');
const fs=require('fs');

// const ngrok = require('ngrok');

dotenv = require('dotenv');
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// app.use(bodyParser.urlencoded({ extended: false })); // Parse URL-encoded bodies
// app.use(bodyParser.json()); // Parse JSON bodies

app.use(express.urlencoded({ extended: false }));

// Security middleware
app.use(helmet());

// rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60 // limit each IP to 60 requests per windowMs
});
app.use(limiter);

// Twilio configuration
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || 'your_account_sid';
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || 'your_auth_token';
// const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || 'your_twilio_phone_number';    

// const twilioClient = twilio(twilioAccountSid, twilioAuthToken);

const callSessions = {}; // Store call sessions in memory

// Validate Twilio webhook signature for security
function validateTwilioSignature(req, res, next) {  
  const twilioSignature = req.headers['x-twilio-signature'];

   if (!twilioSignature) {
    console.log('No Twilio signature found in request headers');
  }

  const url = req.protocol + '://' + req.get('host') + req.originalUrl;
  const body = JSON.stringify(req.body);

  if (!twilio.validateRequest(twilioAuthToken, twilioSignature, url, body)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// Sanitize input to prevent XSS attacks
function sanitizeInput(input) {
  if(!input) return '';
  return validator.escape(input.toString().trim());
}

// Create call session with conversation flow
function createCallSession(callSid, fromNumber) {
    const session={
        callSid: callSid,
        fromNumber: sanitizeInput(fromNumber),
        startTime: new Date(),
        currentStep:'greeting',
        responses: {},
        ConversationFlow:[
            {
                step: 'greeting',
                message: 'Welcome to the Service Market. I have few questions for you.',
                nextStep: 'question1',
                responseKey: 'greetingResponse'
            },
            {
                step: 'question1',
                message: 'What type of Service are you looking for?',
                nextStep: 'question2',
                responseKey: 'serviceTypeResponse'
            },
            {
                step: 'question2',
                message: 'Please provide your location.',
                nextStep: 'question3',
                responseKey: 'locationResponse'
            },
            {
                step: 'question3',
                message: 'What is your budget range?',
                nextStep: 'end',
                responseKey: 'budgetResponse'
            },
            {
                step: 'completion',
                message: 'Thank you for your responses. ',
                nextStep: 'end',
            }
        ]
    };

    callSessions[callSid] = session;
    return session;
}

// current step in the conversation
function getCurrentStep(session) {
    return session.ConversationFlow.find(step => step.step === session.currentStep);
}

// store responses
function storeResponse(session,step, response) {
    session.responses[step] = sanitizeInput(response);
    console.log(`Response for ${step}: ${response}`);
}

function callCompletion(session) {
    console.log('\n=== 📋 CALL COMPLETION SUMMARY ===');
    console.log(`Call SID: ${session.callSid}`);
    console.log(`From Number: ${session.fromNumber}`);
    console.log(`Start Time: ${session.startTime.toISOString()}`);
    console.log(`Total Responses: ${Object.keys(session.responses).length}/3`);
    
    // Log response keys (not actual data for security)
    const responseKeys = Object.keys(session.responses);
    console.log(`Collected Data: [${responseKeys.join(', ')}]`);
    console.log('================================\n');
    
    // Here you would save to your database
    // saveCallToDatabase(session);

    const filePath='sessionStore.txt';
    fs.appendFileSync(filePath, JSON.stringify(session)+'/n');
    console.log('Session appended in file.');
  }

// Handle incoming calls Webhook endpoints
app.post('/incoming-call', validateTwilioSignature, (req, res) => {
    const twilioResponse = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const fromNumber = req.body.From;

    console.log(`Incoming call from ${fromNumber} with Call SID: ${callSid}`);

    // create a new call session
    const session = createCallSession(callSid, fromNumber);
    const currentStep= getCurrentStep(session);
    twilioResponse.say(currentStep.message, { voice: 'alice' });
    session.currentStep= currentStep.nextStep;

    // move to another conversation step
    twilioResponse.redirect('/conversation');
    res.type('text/xml');
    res.send(twilioResponse.toString());
});

app.post('/conversation', validateTwilioSignature, (req, res) => {
    const twilioResponse=new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const session = callSessions[callSid];

    if(!session){
        twilioResponse.say('Sorry, there was error with your call. Please call back.');
        twilioResponse.hangup();
        res.type('text/xml');
        return res.send(twilioResponse.toString());
    }

    const currentStep = getCurrentStep(session);
    if(currentStep=='end'){
        twilioResponse.say({
            voice: 'alice',
        },currentStep.message);
        twilioResponse.hangup();
        callCompletion(session);
    }
    else{
        // ask current question or message and wait for response
        const gather=twilioResponse.gather({
            input: 'speech',
            action: '/handle-response',
            method: 'POST',
            timeout: 5, // wait for 5 seconds for speech input  
            speechTimeout: auto,
        })

        gather.say({
            voice: 'alice',
        }, currentStep.message);

        twilioResponse.say('I didn\'t hear your response. Let me ask the question again.');
        twilioResponse.redirect('/conversation');
    }

    res.type('text/xml');       
    res.send(twilioResponse.toString());
});

// process user response
app.post('/handle-response', validateTwilioSignature, (req, res) => {
    const twilioResponse=new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const speechResult = req.body.SpeechResult;
    const session = callSessions[callSid];

    if(!session){
        twilioResponse.say('Sorry, there was error processing yout response. Please call back.');
        twilioResponse.hangup();
        res.type('text/xml');
        return res.send(twilioResponse.toString());
    }

    // Find current step
    const currentStepIndx= session.ConversationFlow.findIndex(step => step.step === session.currentStep);
    const currentStepResponseKey=session.ConversationFlow[currentStepIndx].responseKey;

    if(speechResult){
        twilioResponse.say({
            voice: 'alice',
        }`Got it.`);
    }
    
    if(currentStepIndx && currentStepResponseKey && speechResult){
        storeResponse(session, currentStepResponseKey, speechResult);
        console.log(`Stored response for ${currentStepResponseKey}: ${speechResult}`);
        
        // twilioResponse.say({
        //     voice: 'alice',
        // }, `Got it.`);
    }
    else {
        twilioResponse.say({
            voice: 'alice',
            language: 'en-US'
        }, 'I didn\'t catch that. Let me continue.');
    }

    // Move to next step
    const nextStep = getCurrentStep(session);
    if (nextStep && nextStep.nextStep) {
        session.currentStep = nextStep.nextStep;
    }

    // Continue with the conversation flow
    twilioResponse.redirect('/conversation');

    res.type('text/xml');
    res.send(twilioResponse.toString());
});

// call status
app.post('/call-status', validateTwilioSignature, (req, res) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const callDuration = req.body.CallDuration;
    
    console.log(`📊 Call ${callSid} status: ${callStatus}${callDuration ? ` (${callDuration}s)` : ''}`);
    
    // Update session with final details
    const session = callSessions.get(callSid);
    if (session && callStatus === 'completed') {
      session.endTime = new Date();
      session.duration = callDuration;
      session.status = 'completed';
    }
    
    // Clean up completed/failed calls after delay
    if (['completed', 'failed', 'no-answer', 'canceled'].includes(callStatus)) {
      setTimeout(() => {
        callSessions.delete(callSid);
        console.log(`🧹 Session cleaned up for call ${callSid}`);
      }, 300000); // Keep for 5 minutes
    }
    
    res.sendStatus(200);
  });


  app.get('/', (req, res) => {
    res.send('Welcome to the Twilio Call Project! Use the /incoming-call endpoint to initiate a call.');
  });

app.listen(port, async() => {
    console.log(`Server is running on port ${port}`);
});
