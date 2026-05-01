const { body, validationResult } = require('express-validator');

const webhookValidationRules = [
  body('screen')
    .exists({ checkNull: true })
    .withMessage('screen is required')
    .isString()
    .withMessage('screen must be a string'),
  body('data')
    .exists({ checkNull: true })
    .withMessage('data is required')
    .isObject()
    .withMessage('data must be an object'),
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}

module.exports = { webhookValidationRules, validate };
