;('use strict')
/**
 * CogniCity Server /floods endpoint
 * @module cities/index
 **/
const cities = require('./model')
const config = require('../config')
const db = require('../utils/db')
const app = require('lambda-api')()
const logger = require('../utils/logger')

const {
    cacheResponse,
    handleGeoResponse,
    checkIfPointInGeometry,
} = require('../utils/utils')

/**
 * Methods to get  reports from database
 * @alias module:src/api/cities/index
 * @param {Object} config Server configuration
 * @param {Object} db sequilize database instance
 */

app.use((req, res, next) => {
    res.cors()
    next()
})

app.get('cities', cacheResponse('1 day'), (req, res) => {
    return cities(config, db)
        .all()
        .then((data) => handleGeoResponse(data, req, res))
        .catch((err) => {
            logger.error('/cities',err)
        })
})

app.get('cities/bounds', cacheResponse('1 day'), (req, res) =>
    cities(config, db)
        .byID(req.query.admin)
        .then((data) => checkIfPointInGeometry(data, req, res))
        .catch((err) => {
            logger.error('/cities/bounds',err)
        })
)

//----------------------------------------------------------------------------//
// Main router handler
//----------------------------------------------------------------------------//
module.exports.main = async (event, context, callback) => {
    await db
        .authenticate()
        .then(() => {
            logger.info('Database connected.')
        })
        .catch((err) => {
            logger.error('Unable to connect to the database:', err)
        })
    // !!!IMPORTANT: Set this flag to false, otherwise the lambda function
    // won't quit until all DB connections are closed, which is not good
    // if you want to freeze and reuse these connections
    context.callbackWaitsForEmptyEventLoop = false

    return await app.run(event, context)

    // Run the request

    // app.run(event, context, callback);
} // end router handler
