'use strict'
/**
 * CogniCity Server /needs endpoint
 * @module needs/index
 **/
const needs = require('./model')
const config = require('../config')
const db = require('../utils/db')
const app = require('lambda-api')()
const AWS = require('aws-sdk')

AWS.config.region = config.AWS_REGION
const lambda = new AWS.Lambda()

const { handleGeoResponse } = require('../utils/utils')

/**
 * Methods to get need reports from database
 * @alias module:src/api/needs/index
 * @param {Object} config Server configuration
 * @param {Object} db sequilize database instance
 */

app.use((req, res, next) => {
    res.cors()
    next()
})

// Get a list of all needs in geo response
app.get('needs/', (req, res) =>
    needs(config, db)
        .all(req.query.is_training, req.query.admin)
        .then((data) => {
            // To map requested items against requested quantities
            const formattedData = data.map((entry) => {
                const itemsRequested = []
                entry.all_item_ids.forEach((item, index) => {
                    itemsRequested.push({
                        'item-id': item,
                        quantity: entry.all_quantity_requested[index] || 0,
                        description: entry.all_descriptions[index] || '',
                    })
                })
                entry.items_requested = itemsRequested

                // Delete the unnecessary items for the response
                delete entry.all_descriptions
                return entry
            })
            return handleGeoResponse(formattedData, req, res)
        })
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: 'Error while fetching data' })
            /* istanbul ignore next */
        })
)

app.get('needs/need', (req, res) =>
    needs(config, db)
        .getByNeedId(req.query)
        .then((data) => res.json(data))
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: 'Error while fetching data' })
            /* istanbul ignore next */
        })
)

app.get('needs/deliveries/:interval', (req, res) =>
    needs(config, db)
        .getItems(req.params)
        .then((data) => res.json(data))
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: 'Error while fetching data' })
            /* istanbul ignore next */
        })
)

app.get('needs/verify-delivery-code', (req, res) =>
    needs(config, db)
        .getDeliveriesByGiverId(req.query)
        .then((data) => res.json(data))
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: 'Error while fetching data' })
            /* istanbul ignore next */
        })
)

app.get('needs/:interval', (req, res) =>
    needs(config, db)
        .getExpiredNeeds(req.params)
        .then(async (data) => {
            return res.status(200).json(data)
        })
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: 'Error while fetching data' })
            /* istanbul ignore next */
        })
)

app.patch('needs/need/:id', (req, res) =>
    needs(config, db)
        .updateNeed(req.body, req.params)
        .then(async (data) => {
            return res.status(200).json({ message: 'Updated Information successfully' })
        })
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: 'Error while fetching data' })
            /* istanbul ignore next */
        })
)

app.patch('needs/giver-details/:id', (req, res) =>
    needs(config, db)
        .rescheduleDeliveryDate(req.body, req.params)
        .then(async (data) => {
            console.log('🚀 ~ .then ~ data:', data)
            // Send Notification
            return res.status(200).json({ message: 'Updated Information successfully', data })
        })
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: `Error updating data${err}` })
            /* istanbul ignore next */
        })
)

app.post('needs/create-need', (req, res) =>
    needs(config, db)
        .addNewNeedReport(req.body)
        .then((data) => {
            const body = {}
            console.log('req.body', req.body)
            const userId = req.body[0].user_id
            const needLanguage = req.body[0]?.need_language
            const isTraining = req.body[0]?.is_training
            body.userId = userId
            body.notifyType = 'need-submitted'
            body.language = needLanguage
            body.is_training = isTraining //added training in the body for training report 
            return invokeNotify(body)
                .then(() => {
                    return res.status(200).json({ message: 'Need requested' })
                })
                .catch((err) => {
                    return res.status(200).json({ message: 'Need requested' })
                })
        })
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ message: 'Could not process request' })
            /* istanbul ignore next */
        })
)

app.post('needs/update-giver', (req, res) =>
    needs(config, db)
        .addGiverReport(req.body)
        .then(async () => {
            const notificationsToSend = ['donor-committed-need', 'donor-committed-giver']
            const fetchByNeedId = await needs(config, db).queryUserIdByNeedId(req.body[0]?.need_id)
            const userId = fetchByNeedId[0]?.user_id
            const needLanguage = fetchByNeedId[0]?.need_language
            const PayloadMap = {
                'donor-committed-need': {
                    userId,
                    notifyType: 'donor-committed-need',
                    deliveryCode: `${req.body[0].delivery_code}`,
                    promisedDate: `${req.body[0].promised_date} , ${req.body[0].promised_time}`,
                    language: needLanguage,
                },
                'donor-committed-giver': {
                    userId: req.body[0].user_id,
                    notifyType: 'donor-committed-giver',
                    itemsPromised: req.body.map((item) => item.item_satisfied).join(','),
                    promisedDate: `${req.body[0].promised_date} , ${req.body[0].promised_time}`,
                    language: req.body[0].giver_language,
                },
            }
            Promise.all(notificationsToSend.map((item) => invokeNotify(PayloadMap[item])))
                .then(() => {
                    return res.status(200).json({ message: 'Giver Details Updated' })
                })
                .catch((err) => {
                    console.error('Error sending notifications:', err)
                    return res.status(200).json({ message: 'Giver Details Updated, but notification failed' })
                })
        })
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ message: 'Could not process request' })
            /* istanbul ignore next */
        })
)

app.delete('needs/giver-details/:id', (req, res) =>
    needs(config, db)
        .deleteGiverDetailsById(req.params.id)
        .then(async (data) => {
            console.log('🚀 ~ .then ~ data:', data)
            // Send Notification
            return res.status(200).json({ message: 'Delete Records successfully' })
        })
        .catch((err) => {
            console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
            return res.status(400).json({ error: `Error deleting data ${err}` })
            /* istanbul ignore next */
        })
)

app.patch('needs/need-details', (req,res) => 
    needs(config, db)
    .UpdateTrainingNeed()
    .then(async (data) => {
        console.log('🚀 ~ .then ~ data:', data)
        // Send Notification
        return res.status(200).json({ message: 'Delete training Need Records successfully' })
    })
    .catch((err) => {
        console.log('🚀 ~ file: index.js ~ line 29 ~ err', err)
        return res.status(400).json({ error: `Error deleting training need data ${err}` })
        /* istanbul ignore next */
    })
)

function invokeNotify(body) {
    return new Promise((resolve, reject) => {
        const eventPayload = {
            body,
        }
        const params = {
            FunctionName: 'logistics-whatsapp-bot-replies', // the lambda function we are going to invoke
            InvocationType: 'Event',
            Payload: JSON.stringify(eventPayload),
        }
        try {
            lambda.invoke(params, (err) => {
                if (err) {
                    console.log('Err', err)
                    reject(err)
                } else {
                    resolve('Lambda invoked')
                    console.log('Lambda invoked')
                }
            })
        } catch (err) {
            console.log('error: ', err)
        }
    })
}

// ----------------------------------------------------------------------------//
// Main router handler
// ----------------------------------------------------------------------------//
module.exports.main = async (event, context, callback) => {
    await db
        .authenticate()
        .then(() => {
            console.info('INFO - Database connected.')
        })
        .catch((err) => {
            console.error('ERROR - Unable to connect to the database:', err)
        })
    // !!!IMPORTANT: Set this flag to false, otherwise the lambda function
    // won't quit until all DB connections are closed, which is not good
    // if you want to freeze and reuse these connections
    context.callbackWaitsForEmptyEventLoop = false

    return await app.run(event, context)

    // Run the request

    // app.run(event, context, callback);
} // end router handler
